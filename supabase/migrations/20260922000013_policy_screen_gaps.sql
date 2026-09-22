-- Part 13: what the policy screen needs and the schema did not have.
--
-- Six cards on the mockup's policy screen had no columns behind them. Adding
-- them here rather than inventing screen-only state, because a policy the
-- calculation cannot read is a policy that does not apply.

-- ---------------------------------------------------------------------------
-- Overtime: multiplier or flat hourly rate
-- ---------------------------------------------------------------------------
-- Not every company pays overtime by multiplier. The mockup offers a flat
-- hourly amount as an alternative, and the two cannot both be in effect — a
-- company on the flat rate has no multiplier to apply, and a company on
-- multipliers has no flat rate to fall back to.
alter table payroll_policies
  add column ot_mode varchar(20) not null default 'multiplier'
    check (ot_mode in ('multiplier', 'fixed_hourly')),
  add column ot_fixed_hourly_rate numeric(18,2);

-- A flat rate is meaningless without an amount, and an amount is misleading
-- when the company is on multipliers. Enforced rather than validated in the
-- form, because payroll is also written to by imports and back-office scripts.
alter table payroll_policies
  add constraint payroll_policies_ot_mode_amount_ck
  check (ot_mode <> 'fixed_hourly' or ot_fixed_hourly_rate > 0);

-- ---------------------------------------------------------------------------
-- Proration: per-department override
-- ---------------------------------------------------------------------------
-- Null means "follow the company default" rather than a value copied down.
-- A copied default silently stops tracking the company setting the moment
-- somebody changes it.
alter table departments
  add column proration_basis varchar(20)
    check (proration_basis in ('calendar', 'fixed_30', 'working_days'));

comment on column departments.proration_basis is
  'null = follow payroll_policies.proration_basis';

-- ---------------------------------------------------------------------------
-- Pay components: the attributes the master screen sets
-- ---------------------------------------------------------------------------
-- recurring: a monthly allowance versus a one-off. The distinction changes
--   PPh 21, because a one-off is taxed in the month it is paid.
-- gross_up: the company absorbs the tax on this component so the employee
--   receives the stated figure net. Common for expatriate packages.
-- borne_by: who pays it. A BPJS line exists twice at different rates — the
--   employee's share is deducted, the employer's is a cost — and one column
--   for both would make the payslip and the remittance disagree.
alter table pay_components
  add column recurring boolean not null default true,
  add column gross_up boolean not null default false,
  add column borne_by varchar(20) not null default 'none'
    check (borne_by in ('none', 'employee', 'employer'));

-- ---------------------------------------------------------------------------
-- Payment types and their schedules
-- ---------------------------------------------------------------------------
-- One row per run type per company. The mockup's point is that THR, a bonus
-- and a resignation settlement are separate batches with their own gates and
-- their own transfer files — so whether a type is merged into the regular run
-- is a setting, not an assumption.
--
-- schedule_rule holds the rule in words because the rules are not the same
-- shape: THR is H-7 before a religious holiday that differs per employee,
-- a bonus is whatever the PKB says, a settlement is triggered by a leaving
-- date. Encoding all three as one structure would fit none of them.
create table payroll_type_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_type payroll_run_type not null,
  enabled boolean not null default true,
  -- 'separate' = its own batch and its own payment file, 'merged' = paid
  -- alongside the regular run.
  execution varchar(20) not null default 'separate'
    check (execution in ('separate', 'merged')),
  frequency varchar(40),                         -- 매월 / 연 1회 / 반기 1회 / 수시
  schedule_rule text,
  legal_basis varchar(255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, run_type)
);
create index payroll_type_settings_company_idx on payroll_type_settings (company_id);

alter table payroll_type_settings enable row level security;

create policy "read payroll_type_settings" on payroll_type_settings for select to authenticated
  using (is_operator() or company_id = current_company_id());
create policy "write payroll_type_settings" on payroll_type_settings for all to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin')))
  with check (is_operator() or (company_id = current_company_id() and has_role('hr_admin')));

-- The regular run is the baseline every other type is described against, so
-- every company gets the four rows rather than an empty screen.
insert into payroll_type_settings (company_id, run_type, execution, frequency, schedule_rule, legal_basis)
select c.id, v.run_type, v.execution, v.frequency, v.schedule_rule, v.legal_basis
  from companies c
 cross join (values
   ('regular'::payroll_run_type, 'separate', '매월',
    '컷오프·지급일은 급여 정책을 따릅니다', null),
   ('thr'::payroll_run_type, 'separate', '연 1회',
    '직원 종교별 공휴일 기준 H-7까지 지급', 'Permenaker No.6/2016'),
   ('bonus'::payroll_run_type, 'separate', '비정기',
    '지급일은 사규·PKB에 따라 회사가 지정 (법정 기한 없음)', null),
   ('resignation'::payroll_run_type, 'separate', '수시 (퇴사 확정 시)',
    '퇴사(PHK)·사직 확정일 기준 오프사이클 정산 · 월 정기 배치에 미포함', null)
 ) as v(run_type, execution, frequency, schedule_rule, legal_basis)
 on conflict (company_id, run_type) do nothing;
