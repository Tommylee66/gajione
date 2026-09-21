-- Part 8: credit scoring and the lending connection.
--
-- GajiOne does not lend. A licensed lender decides and disburses; GajiOne
-- scores, refers, deducts from payroll on the worker's instruction, and
-- reconciles. That boundary is the reason this file has no balance or interest
-- column that we treat as authoritative — loan_mirrors exists only so the
-- deduction can be checked against the lender's book.
--
-- Holding the ledger here would make GajiOne look like the lender regardless
-- of what the contract says, and lending without an OJK licence is a criminal
-- matter, not a compliance finding.

create table credit_score_factors (
  id uuid primary key default gen_random_uuid(),
  code varchar(40) not null unique,
  name varchar(255) not null,
  weight numeric(5,2) not null,                  -- 30 = 30%
  max_points integer not null,
  source varchar(100),                           -- 근태마감(G1) / 대출상환원장 / 인사마스터
  active boolean not null default true,
  effective_from date not null default current_date,
  created_at timestamptz not null default now()
);

create table credit_scores (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  scored_at timestamptz not null default now(),
  base_points integer not null default 300,
  total_score integer not null,
  max_score integer not null default 850,
  -- Which payroll run's confirmed data it was computed from. Scoring off an
  -- open run would move the number under the lender while they were reading it.
  run_id uuid,
  created_at timestamptz not null default now()
);
create index credit_scores_employee_idx on credit_scores (employee_id, scored_at desc);
create index credit_scores_company_idx on credit_scores (company_id);

-- The breakdown, kept because a total on its own cannot answer "why was I
-- turned down" — and because changing a weight must not rewrite the basis of
-- a decision already made.
create table credit_score_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  credit_score_id uuid not null,
  factor_code varchar(40) not null,
  factor_name varchar(255),
  weight numeric(5,2),
  raw_metric text,                               -- '출근율99.1%·무단결근0회'
  normalized numeric(6,2),                       -- 0~100
  points integer not null default 0,
  created_at timestamptz not null default now()
);
create index credit_score_details_score_idx on credit_score_details (credit_score_id);

-- The counterparty. ojk_license_no is not decoration: it is the record that
-- the entity taking the credit risk is allowed to.
create table lender_partners (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  ojk_license_no varchar(100),
  license_type varchar(60),                      -- LPBBTI / multifinance / bank
  contract_ref text,
  contract_from date,
  contract_to date,
  status varchar(20) not null default 'active' check (status in ('active', 'suspended', 'terminated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sending an employee's tenure, attendance rate and score to a lender is
-- disclosure of personal data to a third party, and needs its own basis under
-- UU PDP — in practice, explicit consent at the point of application.
--
-- scope matters because "my credit score" and "my payslip" are not the same
-- permission, and revoked_at matters because consent can be withdrawn. A
-- boolean on the employee row could express neither.
create table data_sharing_consents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  lender_id uuid not null,
  scope varchar(40) not null check (scope in ('score_only', 'score_and_tenure', 'full_payroll')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  evidence_ref text,                             -- signed form, app consent log
  created_at timestamptz not null default now()
);
create index data_sharing_consents_employee_idx on data_sharing_consents (employee_id, lender_id);

-- The handoff. lender_decision and the fields after it are the lender's
-- answer, recorded — not GajiOne's decision.
create table loan_referrals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  lender_id uuid not null,
  product_label varchar(100),                    -- 사내대출 / 가불(EWA)
  amount_requested numeric(18,2) not null,
  months integer,
  credit_score_id uuid,
  score_snapshot integer,
  consent_id uuid,
  referred_at timestamptz,
  lender_decision varchar(20) check (lender_decision in ('approved', 'rejected', 'pending')),
  lender_ref_no varchar(100),
  decided_at timestamptz,
  decline_reason text,
  status referral_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index loan_referrals_employee_idx on loan_referrals (employee_id, created_at desc);
create index loan_referrals_lender_idx on loan_referrals (lender_id, status);
create index loan_referrals_company_idx on loan_referrals (company_id, status);

-- The worker's standing instruction to deduct. Money does not leave a payslip
-- without one, and its scope and period have to be on the record.
--
-- max_rate carries the mockup's 30%-of-net ceiling. It is checked here and
-- again against payroll_policies, because the two can disagree and the lower
-- one has to win.
create table deduction_mandates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  lender_id uuid not null,
  referral_id uuid,
  lender_ref_no varchar(100),
  monthly_amount numeric(18,2) not null,
  total_installments integer not null,
  start_period char(7) not null,                 -- 'YYYY-MM'
  end_period char(7),
  max_rate numeric(5,2) not null default 30,
  mandate_ref text,                              -- the signed instruction itself
  status mandate_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deduction_mandates_employee_idx on deduction_mandates (employee_id, status);
create index deduction_mandates_lender_idx on deduction_mandates (lender_id, status);
create index deduction_mandates_company_idx on deduction_mandates (company_id, status);

-- What was actually taken, from which payslip, and when it was remitted. This
-- is what answers the lender's question "what did you deduct in August and
-- when did you send it".
create table deduction_executions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  mandate_id uuid not null,
  run_id uuid not null,
  payroll_item_id uuid,
  period char(7) not null,
  installment_no integer,
  amount numeric(18,2) not null default 0,
  -- Set when the deduction was skipped or trimmed: unpaid leave, the 30%
  -- ceiling, a deferral the lender granted.
  shortfall_reason varchar(100),
  remitted_at timestamptz,
  remittance_ref varchar(100),
  status varchar(20) not null default 'deducted' check (status in ('deducted', 'skipped', 'partial', 'remitted', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mandate_id, period)
);
create index deduction_executions_run_idx on deduction_executions (run_id);
create index deduction_executions_company_idx on deduction_executions (company_id, period);

-- Period totals agreed with each lender. A difference here is the first sign
-- that a mandate, a payslip or a transfer went wrong.
create table lender_reconciliations (
  id uuid primary key default gen_random_uuid(),
  lender_id uuid not null,
  company_id uuid not null,
  period char(7) not null,
  expected_total numeric(18,2) not null default 0,
  deducted_total numeric(18,2) not null default 0,
  remitted_total numeric(18,2) not null default 0,
  diff_amount numeric(18,2) not null default 0,
  status varchar(20) not null default 'open' check (status in ('open', 'matched', 'disputed', 'closed')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lender_id, company_id, period)
);

-- A copy of the lender's book, for reconciliation only. Never the source of
-- truth, never shown to the employee as their balance — synced_at says how
-- stale it is, and it will sometimes be wrong.
create table loan_mirrors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  lender_id uuid not null,
  lender_ref_no varchar(100) not null,
  principal numeric(18,2),
  balance numeric(18,2),
  paid_installments integer,
  total_installments integer,
  is_overdue boolean not null default false,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (lender_id, lender_ref_no)
);
create index loan_mirrors_employee_idx on loan_mirrors (employee_id);
