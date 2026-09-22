-- Part 20: the lender's side of the loan.
--
-- Until now the lender's decision was typed in by HR, which means somebody
-- read it off a phone call. This gives the lender a place to make it.
--
-- The privacy shape is the point. A partner gets the credit profile GajiOne
-- computed and nothing else — no NIK, no NPWP, no payslip, no employee row.
-- That is enforced by what is written down rather than by what is queried:
-- the profile is snapshotted onto the referral when it is sent, and the lender
-- has no read policy on employees, companies or payroll at all.

-- ---------------------------------------------------------------------------
-- The profile the partner sees
-- ---------------------------------------------------------------------------
-- Frozen at referral time, not looked up. A score that moves while the lender
-- is reading it is a different application from the one they were sent, and
-- the alternative — granting read access to the source tables — hands over far
-- more than the decision needs.
alter table loan_referrals add column profile_snapshot jsonb;

comment on column loan_referrals.profile_snapshot is
  'What the partner portal shows: employee_no, employer, tenure, attendance, late count, pay stability. Never identity or pay.';

-- The borrower's name, from the point a loan exists. Before that the partner
-- sees a staff number: they are assessing a profile, not a person. After
-- disbursement there is a credit agreement and they necessarily know who it is
-- with.
alter table deduction_mandates add column borrower_name varchar(255);

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------
-- The terms are the lender's to set — rate, fee, repayment method — and
-- GajiOne records them rather than computing them. Kept as their own table
-- because one application can be offered, expire and be offered again, and
-- overwriting the first offer would lose what was declined.
create table loan_offers (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  lender_id uuid not null,
  company_id uuid not null,                      -- so the employer can read its own
  annual_rate numeric(6,3) not null,             -- percent, e.g. 18.000
  months integer not null,
  fee_percent numeric(6,3) not null default 0,
  repayment_method varchar(20) not null default 'annuity'
    check (repayment_method in ('annuity', 'equal_principal')),
  -- Computed by the portal and stored, so the figure the employee was shown is
  -- the figure on file. Recomputing it later from the rate would drift with
  -- any change to the formula.
  monthly_amount numeric(18,2) not null,
  first_month_amount numeric(18,2),              -- differs under equal_principal
  fee_amount numeric(18,2) not null default 0,
  total_repayment numeric(18,2) not null default 0,
  -- An offer that never expires is an option the lender wrote for free.
  expires_at timestamptz not null,
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  decline_reason text,
  status varchar(20) not null default 'sent'
    check (status in ('sent', 'accepted', 'declined', 'expired', 'withdrawn', 'disbursed')),
  disbursed_at timestamptz,
  lender_ref_no varchar(100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index loan_offers_referral_idx on loan_offers (referral_id, sent_at desc);
create index loan_offers_lender_idx on loan_offers (lender_id, status);
create index loan_offers_company_idx on loan_offers (company_id, status);

alter table loan_offers enable row level security;

-- The lender writes their own offers; the employer reads the ones made to its
-- own staff, because HR has to see the terms before a deduction is set up.
create policy "lender writes own offers" on loan_offers for all to authenticated
  using (is_operator() or lender_id = current_lender_id())
  with check (is_operator() or lender_id = current_lender_id());
create policy "company reads its offers" on loan_offers for select to authenticated
  using (company_id = current_company_id());
-- Acceptance is the employee's answer, relayed by HR until the employee app
-- exists. Narrowed to that: HR may move a sent offer, never write one.
create policy "company responds to offers" on loan_offers for update to authenticated
  using (company_id = current_company_id() and has_role('hr_admin'))
  with check (company_id = current_company_id() and has_role('hr_admin'));

-- ---------------------------------------------------------------------------
-- The lender's write on the referral
-- ---------------------------------------------------------------------------
-- Read-only until now, which left the partner unable to record anything they
-- decided. Scoped to their own rows; which columns may move is the action's
-- job, since RLS has no column granularity.
create policy "lender updates own referrals" on loan_referrals for update to authenticated
  using (lender_id = current_lender_id())
  with check (lender_id = current_lender_id());

-- The breakdown behind the score, so "why this rate" has an answer. Same
-- consent gate as the score itself.
create policy "lender reads consented score details" on credit_score_details for select to authenticated
  using (credit_score_id in (
    select s.id from credit_scores s
     join data_sharing_consents c
       on c.employee_id = s.employee_id
      and c.lender_id = current_lender_id()
      and c.revoked_at is null
  ));

-- Partners need their own row to render the portal header; they have no
-- business reading each other's licence details.
create policy "lender reads own partner row" on lender_partners for select to authenticated
  using (is_operator() or id = current_lender_id());

-- A mirror of the lender's book is written by the lender, for reconciliation.
create policy "lender writes own mirrors" on loan_mirrors for all to authenticated
  using (is_operator() or lender_id = current_lender_id())
  with check (is_operator() or lender_id = current_lender_id());
