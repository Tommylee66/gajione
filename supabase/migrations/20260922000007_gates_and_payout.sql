-- Part 7: G3 and G4.

-- Rules live in a table, not in code, because the thresholds are per company:
-- a ±20% variance band is a policy choice, and so is whether a rule stops the
-- run or merely annotates it. The mockup passes 12 of 14 rules and still
-- advances, so severity has to be data.
create table gate_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,                               -- null = applies to every tenant
  code varchar(60) not null,
  gate varchar(2) not null check (gate in ('G1', 'G2', 'G3', 'G4')),
  name varchar(255) not null,
  description text,
  severity gate_severity not null default 'blocking',
  threshold numeric(18,4),
  legal_basis varchar(255),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gate_rules_lookup_idx on gate_rules (gate, active);

create table gate_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  rule_code varchar(60) not null,
  gate varchar(2) not null,
  passed boolean not null,
  severity gate_severity not null,
  detail jsonb,
  checked_at timestamptz not null default now(),
  unique (run_id, rule_code)
);
create index gate_results_run_idx on gate_results (run_id, gate);

-- The two-step explanation workflow: the line manager explains, HR decides.
--
-- Both sides get their own actor and timestamp because "who let this through"
-- is the question that gets asked months later, and one approver column cannot
-- answer it.
create table variance_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  employee_id uuid not null,
  prev_net numeric(18,2),
  curr_net numeric(18,2),
  change_rate numeric(8,2),

  line_manager_id uuid,
  line_comment text,
  line_submitted_at timestamptz,

  hr_approver_id uuid,
  hr_decision varchar(20) check (hr_decision in ('approved', 'rejected', 'returned')),
  hr_comment text,
  hr_decided_at timestamptz,

  status varchar(20) not null default 'pending' check (status in ('pending', 'explained', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, employee_id)
);
create index variance_cases_run_idx on variance_cases (run_id, status);

-- Sequential signatures, delegation not permitted. step_no carries the order
-- and the unique constraint stops the same step being signed twice; the
-- application must refuse to write step n while n-1 is unsigned.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  step_no integer not null,
  role_label varchar(60) not null,               -- 급여담당 / HR장 / 법인장
  expected_user_id uuid,
  approver_id uuid,
  signed_at timestamptz,
  signature_ref text,
  status approval_status not null default 'pending',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, step_no)
);
create index approvals_run_idx on approvals (run_id, step_no);

-- The bank transfer file. total_amount and record_count are stored so the file
-- can be reconciled against the run without reopening it.
create table payment_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  bank_code varchar(40) not null,                -- 'HANA_ID'
  format varchar(40) not null default 'h2h',
  file_ref text,
  file_hash varchar(64),
  total_amount numeric(18,2) not null default 0,
  record_count integer not null default 0,
  generated_at timestamptz not null default now(),
  sent_at timestamptz,
  status varchar(20) not null default 'generated' check (status in ('generated', 'sent', 'acknowledged', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_files_run_idx on payment_files (run_id);

-- Delivery and readership. The mockup tracks a 91% open rate, and "I never got
-- my payslip" is a dispute the company has to be able to answer.
create table payslips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payroll_item_id uuid not null,
  employee_id uuid not null,
  channel varchar(20) not null check (channel in ('whatsapp', 'email', 'app', 'print')),
  file_ref text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  status varchar(20) not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'opened', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payslips_item_idx on payslips (payroll_item_id);
create index payslips_company_idx on payslips (company_id, status);

-- Drafts for the statutory filings that follow payment: e-Bupot for PPh 21,
-- SIPP for BPJS. Held here rather than regenerated so the filed figures and
-- the paid figures can be compared later.
create table tax_filings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  kind varchar(40) not null check (kind in ('ebupot_pph21', 'sipp_bpjs')),
  period char(7) not null,
  draft_ref text,
  total_amount numeric(18,2),
  generated_at timestamptz not null default now(),
  submitted_at timestamptz,
  receipt_no varchar(100),
  status varchar(20) not null default 'draft' check (status in ('draft', 'submitted', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tax_filings_run_idx on tax_filings (run_id);
create index tax_filings_company_idx on tax_filings (company_id, period desc);
