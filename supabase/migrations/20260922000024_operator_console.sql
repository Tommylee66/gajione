-- Part 24: what the operator console needs that the tenancy tables did not have.
--
-- plans carried a base fee, a per-employee fee and a white-label fee. The
-- pricing screen sets three more things, and each of them changes what a
-- customer is billed: volume tiers, an annual prepayment discount, and a
-- white-label monthly charge distinct from its setup fee.

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------
-- Tiers as jsonb rather than a table: a plan has two or three of them, they
-- are edited together as one form, and a row per tier would make reordering
-- and deleting a transaction for something that is a single field on a screen.
--
-- Shape: [{ "over": 200, "discount_percent": 5 }, ...] — the per-employee fee
-- is discounted by discount_percent for every head above `over`.
alter table plans
  add column volume_tiers jsonb not null default '[]',
  add column annual_prepay_discount numeric(5,2) not null default 0
    check (annual_prepay_discount >= 0 and annual_prepay_discount <= 100),
  -- whitelabel_fee was one number doing two jobs. Setup is charged once and
  -- maintenance monthly; billing a customer the setup fee every month is the
  -- kind of error an invoice run makes silently.
  add column whitelabel_monthly_fee numeric(18,2) not null default 0;

comment on column plans.whitelabel_fee is 'One-off setup charge.';
comment on column plans.whitelabel_monthly_fee is 'Recurring monthly maintenance.';

-- ---------------------------------------------------------------------------
-- The customer record the console shows
-- ---------------------------------------------------------------------------
-- 'trial' and 'churning' are states the console filters on and the existing
-- check constraint had no room for. Dropped and rewritten rather than added
-- to, because a check constraint cannot be extended in place.
alter table companies drop constraint if exists companies_status_check;
alter table companies
  add constraint companies_status_check
  check (status in ('active', 'trial', 'churning', 'suspended', 'closed'));

alter table companies
  add column contract_started_on date,
  add column contract_renews_on date,
  add column cs_owner varchar(120),
  add column churn_reason text,
  -- Whether the lending connection is switched on for this customer. Off by
  -- default: it involves sending profiles to a third party and should be a
  -- decision, not an inheritance.
  add column lending_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Invoice lines
-- ---------------------------------------------------------------------------
-- The invoice already stores its own totals. What it could not show is how the
-- volume discount was arrived at, which is the first thing a customer asks
-- about. Stored per invoice so the explanation survives a pricing change.
alter table billing_invoices
  add column plan_code varchar(40),
  add column breakdown jsonb not null default '{}';

comment on column billing_invoices.breakdown is
  'How the total was reached: tiers applied, rates used, headcount at the time.';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- plans already had operator-only writes from part 9's reference-data block.
-- subscriptions and billing_invoices had none at all, so nothing could read or
-- write them. A customer sees its own invoices; only the operator sees anyone
-- else's, or changes any of it.
alter table subscriptions enable row level security;
alter table billing_invoices enable row level security;

create policy "operator manages subscriptions" on subscriptions for all to authenticated
  using (is_operator()) with check (is_operator());
create policy "company reads own subscription" on subscriptions for select to authenticated
  using (company_id = current_company_id() and is_tenant_staff());

create policy "operator manages invoices" on billing_invoices for all to authenticated
  using (is_operator()) with check (is_operator());
create policy "company reads own invoices" on billing_invoices for select to authenticated
  using (company_id = current_company_id() and is_tenant_staff());

-- The operator console lists every tenant. companies had a read policy for
-- the operator already; this adds the write it needs to onboard one.
create policy "operator writes companies rows" on companies for all to authenticated
  using (is_operator()) with check (is_operator());
