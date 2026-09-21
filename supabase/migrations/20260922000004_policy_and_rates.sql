-- Part 4: the numbers payroll is computed from.
--
-- Every table here is versioned by effective date and none of them is ever
-- updated in place. A rate that is corrected gets a new row; the old row keeps
-- explaining the runs that used it.
--
-- This is the difference between being able to answer "recompute March" and
-- not. The mockup already tags its tax table `TER-2026.1`, which is the same
-- instinct — it just has to hold for BPJS, UMK and overtime as well.

-- Allowances and deductions a company defines for itself (transport, meals,
-- attendance bonus, union dues …).
--
-- The four booleans are the whole calculation contract. The mockup's transport
-- row reads `Rp450,000/월 · 과세 · BPJS포함 · 일할O`, and those flags decide
-- whether it enters taxable income, whether it raises the BPJS base, and
-- whether a mid-month joiner gets a fraction of it. Adding a component is a
-- row, not a code change.
create table pay_components (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code varchar(40) not null,
  name varchar(255) not null,
  kind pay_component_kind not null,
  calc_type pay_calc_type not null default 'fixed',
  amount numeric(18,2),                          -- fixed amount, or the rate for rate_of_base
  formula text,                                  -- only for calc_type = 'formula'
  taxable boolean not null default true,
  bpjs_base boolean not null default true,
  prorate boolean not null default true,
  ot_base boolean not null default false,        -- counts toward the overtime hourly base
  sort_order integer not null default 0,
  active boolean not null default true,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code, effective_from)
);
create index pay_components_company_idx on pay_components (company_id, active);

-- Overtime multipliers as brackets, straight from Kepmenakertrans 102/2004:
-- weekday first hour 1.5x, from the second 2.0x, holiday within 8h 2.0-3.0x,
-- from the ninth 4.0x.
--
-- multiplier_max is nullable because the holiday-within-8h band is quoted as a
-- range. Until the rule that picks a point inside it is confirmed, a run that
-- hits that band should refuse to guess rather than silently take one end.
create table ot_rate_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,                               -- null = statutory default, shared by every tenant
  day_type varchar(20) not null check (day_type in ('weekday', 'holiday', 'national_holiday')),
  from_hour numeric(5,2) not null,
  to_hour numeric(5,2),                          -- null = open ended
  multiplier numeric(5,2) not null,
  multiplier_max numeric(5,2),
  legal_basis varchar(255),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now()
);
create index ot_rate_rules_lookup_idx on ot_rate_rules (day_type, effective_from desc);

create table bpjs_rates (
  id uuid primary key default gen_random_uuid(),
  program varchar(20) not null check (program in ('kesehatan', 'jht', 'jp', 'jkk', 'jkm')),
  employee_rate numeric(6,4) not null default 0,
  employer_rate numeric(6,4) not null default 0,
  -- JP caps the contributable wage; without this the deduction runs away at
  -- the top of the payroll.
  wage_cap numeric(18,2),
  -- JKK varies by industry risk class, so the same program has several rows.
  risk_class varchar(20),
  version varchar(40) not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now()
);
create index bpjs_rates_lookup_idx on bpjs_rates (program, effective_from desc);

-- PPh 21 under the TER method (PMK 168/2023): a monthly effective rate looked
-- up by TER category and gross income band.
create table tax_tables (
  id uuid primary key default gen_random_uuid(),
  version varchar(40) not null,                  -- 'TER-2026.1'
  method varchar(20) not null default 'ter' check (method in ('ter', 'progressive')),
  category varchar(10),                          -- TER A / B / C, derived from PTKP status
  lower_bound numeric(18,2) not null,
  upper_bound numeric(18,2),
  rate numeric(6,4) not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now()
);
create index tax_tables_lookup_idx on tax_tables (version, category, lower_bound);

create table umk_rates (
  id uuid primary key default gen_random_uuid(),
  region varchar(100) not null,
  amount numeric(18,2) not null,
  year integer not null,
  effective_from date not null,
  created_at timestamptz not null default now(),
  unique (region, year)
);

-- Per-company payroll conventions. The cut-off in the mockup runs 07-26 to
-- 08-25 with payment on 08-28, so none of these can be assumed.
create table payroll_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  cutoff_start_day integer not null default 26 check (cutoff_start_day between 1 and 31),
  cutoff_end_day integer not null default 25 check (cutoff_end_day between 1 and 31),
  payday integer not null default 28 check (payday between 1 and 31),
  -- Hourly rate = monthly wage / 173 (Kepmenakertrans 102/2004). Kept as a
  -- number because a company may agree a more favourable divisor.
  ot_hour_divisor numeric(8,2) not null default 173,
  weekly_ot_cap_minutes integer not null default 1080,   -- 18h, UU 13/2003
  -- Where rounding happens changes the total. 'line' rounds each component,
  -- 'total' rounds only the net — the two differ by a few rupiah per employee,
  -- which is exactly what a tax office recomputation surfaces.
  rounding_scope varchar(10) not null default 'line' check (rounding_scope in ('line', 'total')),
  rounding_unit integer not null default 1,
  -- Calendar days in the month, or a flat 30. Both are used in Indonesia.
  proration_basis varchar(20) not null default 'calendar' check (proration_basis in ('calendar', 'fixed_30', 'working_days')),
  max_loan_deduction_rate numeric(5,2) not null default 30,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payroll_policies_company_idx on payroll_policies (company_id, effective_from desc);
