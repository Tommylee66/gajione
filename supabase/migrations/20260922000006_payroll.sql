-- Part 6: G2, the payroll run.
--
-- A run carries the versions it computed with. Once it is locked, changing a
-- rate, an allowance or a policy cannot move its numbers, because the numbers
-- were written down rather than derived on read. Last month's payslip has to
-- keep saying what it said when it was issued.

create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period char(7) not null,                       -- 'YYYY-MM'
  run_type payroll_run_type not null default 'regular',
  -- Several runs of the same type can share a month. The mockup's customer
  -- pays THR alongside the regular August payroll, and a resignation
  -- settlement lands whenever someone leaves.
  seq integer not null default 1,
  cutoff_start date not null,
  cutoff_end date not null,
  pay_date date not null,
  status payroll_status not null default 'draft',

  -- The frozen inputs. Everything below is written when the run is computed
  -- and never updated afterwards.
  tax_table_version varchar(40),
  bpjs_rate_version varchar(40),
  umk_amount numeric(18,2),
  policy_snapshot jsonb,                         -- payroll_policies row as it stood
  -- Hash over the computed lines. G2 passes when two independent passes agree
  -- on it; it is also what proves afterwards that nothing was edited in place.
  batch_hash varchar(64),

  employee_count integer not null default 0,
  gross_total numeric(18,2) not null default 0,
  deduction_total numeric(18,2) not null default 0,
  net_total numeric(18,2) not null default 0,

  computed_at timestamptz,
  locked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, period, run_type, seq)
);
create index payroll_runs_company_period_idx on payroll_runs (company_id, period desc);
create index payroll_runs_status_idx on payroll_runs (company_id, status);

-- Per employee, per run.
create table payroll_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  employee_id uuid not null,

  -- Copied from the employee as they stood at cut-off. A transfer or a leaver
  -- afterwards must not rewrite a closed payslip.
  employee_no varchar(40),
  employee_name varchar(255),
  department_id uuid,
  position_id uuid,
  base_salary numeric(18,2) not null default 0,
  ptkp_status varchar(10),

  work_days numeric(5,1) not null default 0,
  ot_minutes integer not null default 0,
  gross numeric(18,2) not null default 0,
  taxable_gross numeric(18,2) not null default 0,
  bpjs_base numeric(18,2) not null default 0,
  deduction_total numeric(18,2) not null default 0,
  net numeric(18,2) not null default 0,

  -- Net of the preceding run of the same type, so G3's ±20% check does not
  -- have to reach back across runs while it is evaluating.
  prev_net numeric(18,2),

  status varchar(20) not null default 'computed' check (status in ('computed', 'held', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, employee_id)
);
create index payroll_items_company_idx on payroll_items (company_id, run_id);
create index payroll_items_employee_idx on payroll_items (employee_id);

-- One row per component on one payslip.
--
-- The name, quantity and unit rate are copied in, not looked up through
-- component_code. Raising the transport allowance next month must not change
-- what last month's payslip says it paid.
create table payroll_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payroll_item_id uuid not null,
  component_code varchar(40),
  component_name varchar(255) not null,
  kind pay_component_kind not null,
  quantity numeric(12,2),
  rate numeric(18,2),
  amount numeric(18,2) not null default 0,
  taxable boolean not null default true,
  bpjs_base boolean not null default true,
  legal_basis varchar(255),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index payroll_lines_item_idx on payroll_lines (payroll_item_id);
create index payroll_lines_company_idx on payroll_lines (company_id);

-- Overtime broken out by bracket, because that is how the hours have to be
-- shown and how a labour inspector reads them.
create table payroll_ot_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payroll_item_id uuid not null,
  day_type varchar(20) not null,
  bracket_label varchar(100) not null,           -- '평일 첫 1시간'
  multiplier numeric(5,2) not null,
  hours numeric(8,2) not null default 0,
  hourly_rate numeric(18,2) not null default 0,
  amount numeric(18,2) not null default 0,
  legal_basis varchar(255),
  created_at timestamptz not null default now()
);
create index payroll_ot_lines_item_idx on payroll_ot_lines (payroll_item_id);

-- Both passes of the parallel recomputation. The mockup requires 412/412
-- agreement before G2 opens.
--
-- This is not belt and braces. Payroll aggregates in an order that is not
-- guaranteed to repeat, and a mismatch is nearly always a real bug in a rate
-- lookup or a rounding boundary. Finding it here costs a rerun; finding it
-- after payment costs 412 corrections and a conversation with the labour
-- office.
create table payroll_recalcs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  pass_no integer not null check (pass_no in (1, 2)),
  batch_hash varchar(64) not null,
  matched_count integer not null default 0,
  mismatch_count integer not null default 0,
  mismatch_detail jsonb,
  computed_at timestamptz not null default now(),
  unique (run_id, pass_no)
);
create index payroll_recalcs_run_idx on payroll_recalcs (run_id);
