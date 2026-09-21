-- Part 3: people.
--
-- NIK, salary and bank account numbers live here. All three are "specific
-- personal data" under UU PDP art. 4 — financial data and a national identity
-- number — which is why the last migration masks them in the data-access layer
-- and encrypts the account number before it is stored.

create table departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code varchar(40) not null,
  name varchar(255) not null,
  -- Production lines hang off departments in the mockup's org (조립1 under
  -- 조립). Self-referencing by column, no constraint.
  parent_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);
create index departments_company_idx on departments (company_id);
create index departments_parent_idx on departments (parent_id);

-- ot_eligible sits on the position, not the employee: Indonesian practice
-- excludes managerial grades from overtime, and that is a property of the rank.
create table positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name varchar(255) not null,
  grade_level integer,
  ot_eligible boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index positions_company_idx on positions (company_id);

create table employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_no varchar(40) not null,
  full_name varchar(255) not null,
  nik varchar(32),                               -- 주민등록번호 (KTP). Specific personal data.
  npwp varchar(30),
  birth_date date,
  gender varchar(10) check (gender in ('M', 'F')),
  join_date date not null,
  resign_date date,
  employment_type employment_type not null default 'permanent',
  department_id uuid,
  position_id uuid,
  base_salary numeric(18,2) not null default 0,
  -- PTKP status (TK/0, K/2 …) decides the tax-free allowance, so PPh 21 cannot
  -- be computed without it.
  ptkp_status varchar(10),
  -- Overrides the company's region for someone posted elsewhere; the UMK check
  -- in G2 reads this first and falls back to companies.umk_region.
  umk_region varchar(100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_no)
);
create index employees_company_idx on employees (company_id);
create index employees_department_idx on employees (department_id);
create index employees_active_idx on employees (company_id, is_active);

-- A resigned employee's row stays. Past payroll runs, tax filings and loan
-- deductions all name it, and those have their own retention periods measured
-- in years. Erasure is done by clearing the identifying columns, never by
-- deleting the row.

-- account_number holds the AES-256-GCM payload ({iv, authTag, ciphertext}),
-- not the digits. The key lives in the application environment, so a dump of
-- this table alone does not yield anyone's bank details.
create table employee_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  bank_name varchar(100) not null,
  account_number_encrypted jsonb,
  account_number_last4 varchar(4),               -- shown in lists; reveals nothing on its own
  holder_name varchar(255),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index employee_bank_accounts_employee_idx on employee_bank_accounts (employee_id);

create table employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  doc_type varchar(60) not null,                 -- KTP / KK / NPWP / ijazah …
  status varchar(20) not null default 'missing' check (status in ('missing', 'submitted', 'verified', 'expired')),
  file_ref text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index employee_documents_employee_idx on employee_documents (employee_id);

-- Salary changes are rows, not an UPDATE on employees.base_salary. Two things
-- need them: the audit question "who approved this raise, and when did it take
-- effect", and G3's ±20% variance check, which compares a period against what
-- was in force before it.
create table employee_salary_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  effective_date date not null,
  previous_amount numeric(18,2),
  new_amount numeric(18,2) not null,
  change_rate numeric(6,2),
  reason text,
  approved_by uuid,
  created_at timestamptz not null default now()
);
create index employee_salary_history_employee_idx on employee_salary_history (employee_id, effective_date desc);
