-- Part 2: tenants, plans, billing, logins.
--
-- companies.id is the tenant key that every other table carries. Getting that
-- column onto a table is not a style choice — it is what the RLS policies in
-- the final migration filter on, and a table without it cannot be isolated.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  industry varchar(100),
  npwp varchar(30),
  nib varchar(30),
  address text,
  -- Which UMK applies is a property of where the company operates, and it is
  -- read on every payroll run, so it lives here rather than being looked up.
  umk_region varchar(100),
  status varchar(20) not null default 'active' check (status in ('active', 'suspended', 'closed')),
  joined_at date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  code varchar(40) not null unique,
  name varchar(100) not null,
  base_fee numeric(18,2) not null default 0,
  per_employee_fee numeric(18,2) not null default 0,
  whitelabel_fee numeric(18,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Subscriptions are history, not a column on companies. A customer who moves
-- from one plan to another still has last quarter's invoices to explain, and
-- those only make sense against the plan that was in force then.
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  plan_id uuid not null,
  discount_rate numeric(5,2) not null default 0 check (discount_rate >= 0 and discount_rate <= 100),
  whitelabel boolean not null default false,
  started_on date not null,
  ended_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_company_idx on subscriptions (company_id, started_on desc);

-- employee_count is stored, not derived. Headcount moves every month; an
-- invoice has to keep saying what it charged for.
create table billing_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period char(7) not null,                       -- 'YYYY-MM'
  employee_count integer not null default 0,
  base_amount numeric(18,2) not null default 0,
  per_employee_amount numeric(18,2) not null default 0,
  whitelabel_amount numeric(18,2) not null default 0,
  discount_amount numeric(18,2) not null default 0,
  total_amount numeric(18,2) not null default 0,
  status varchar(20) not null default 'issued' check (status in ('draft', 'issued', 'paid', 'void')),
  issued_on date,
  paid_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, period)
);
create index billing_invoices_company_idx on billing_invoices (company_id, period desc);

-- One row per login, keyed to Supabase Auth.
--
-- The three id columns are mutually exclusive in practice and decide what the
-- login is:
--   company_id null + lender_id null -> GajiOne operator, sees every tenant
--   company_id set                   -> works at that customer
--   lender_id set                    -> works at a partner lender
--
-- employee_id is set as well for the employee app, so a worker's login can be
-- tied to their own payroll rows without a join through name or number.
create table users (
  id uuid primary key,                           -- = auth.users.id
  email varchar(255),
  full_name varchar(255) not null,
  role user_role not null,
  company_id uuid,
  employee_id uuid,
  lender_id uuid,
  is_active boolean not null default true,
  is_approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_company_idx on users (company_id);
create index users_employee_idx on users (employee_id);
create index users_lender_idx on users (lender_id);

-- A line manager sees their own departments and no others. Kept as rows rather
-- than a column because the mockup's org has lines nested under departments and
-- a supervisor can hold more than one.
create table user_scopes (
  id uuid primary key default gen_random_uuid(),
  -- Carried here as well as on the user, so the row can be filtered by the
  -- same tenant policy as everything else. Without it this table would need a
  -- policy that joins back through users, which is the one shape that gets
  -- forgotten when a new table is added.
  company_id uuid not null,
  user_id uuid not null,
  department_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, department_id)
);
create index user_scopes_user_idx on user_scopes (user_id);
create index user_scopes_company_idx on user_scopes (company_id);
