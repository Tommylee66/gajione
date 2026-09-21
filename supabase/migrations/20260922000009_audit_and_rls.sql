-- Part 9: audit, row-level security, and the checks that stand in for the
-- foreign keys we did not create.

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Insert only. No update or delete policy exists for any role, so the trail
-- cannot be edited even from a compromised session. Nothing writes here
-- implicitly — there are no triggers — so every server action that changes
-- money, approves a gate, signs off a run, reveals a bank account or exports
-- data has to call log_audit itself.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,
  actor_id uuid,
  actor_role user_role,
  action varchar(100) not null,
  target_table varchar(100),
  target_id varchar(100),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);
create index audit_log_company_idx on audit_log (company_id, created_at desc);
create index audit_log_target_idx on audit_log (target_table, target_id);

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------
-- Security definer and stable: they read `users`, which is itself protected,
-- and they run once per statement rather than per row.

create or replace function current_user_row()
returns users as $$
  select * from users where id = auth.uid() and is_active and is_approved;
$$ language sql security definer stable;

create or replace function is_operator()
returns boolean as $$
  select exists (
    select 1 from users
     where id = auth.uid() and is_active and is_approved
       and company_id is null and lender_id is null
  );
$$ language sql security definer stable;

create or replace function current_company_id()
returns uuid as $$
  select company_id from users where id = auth.uid() and is_active and is_approved;
$$ language sql security definer stable;

create or replace function current_employee_id()
returns uuid as $$
  select employee_id from users where id = auth.uid() and is_active and is_approved;
$$ language sql security definer stable;

create or replace function current_lender_id()
returns uuid as $$
  select lender_id from users where id = auth.uid() and is_active and is_approved;
$$ language sql security definer stable;

create or replace function has_role(variadic roles user_role[])
returns boolean as $$
  select exists (
    select 1 from users
     where id = auth.uid() and is_active and is_approved and role = any(roles)
  );
$$ language sql security definer stable;

create or replace function log_audit(
  p_action varchar,
  p_target_table varchar default null,
  p_target_id varchar default null,
  p_details jsonb default '{}'
)
returns void as $$
  insert into audit_log (company_id, actor_id, actor_role, action, target_table, target_id, details)
  select company_id, id, role, p_action, p_target_table, p_target_id, p_details
    from users where id = auth.uid();
$$ language sql security definer;

grant execute on function log_audit(varchar, varchar, varchar, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Tenant isolation is the one thing that cannot be left to application code.
-- Every payroll table gets the same shape: the operator sees everything,
-- company staff see their own company, and nobody else sees anything.
--
-- Employee and lender access is narrower and is added per table below, because
-- "their own rows" means something different on each.

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'plans', 'subscriptions', 'billing_invoices', 'users', 'user_scopes',
    'departments', 'positions', 'employees', 'employee_bank_accounts',
    'employee_documents', 'employee_salary_history',
    'pay_components', 'ot_rate_rules', 'bpjs_rates', 'tax_tables', 'umk_rates',
    'payroll_policies', 'devices', 'shifts', 'shift_schedules', 'attendance_raw',
    'attendance_days', 'ot_requests', 'leave_types', 'leaves', 'leave_balances',
    'attendance_anomalies', 'payroll_runs', 'payroll_items', 'payroll_lines',
    'payroll_ot_lines', 'payroll_recalcs', 'gate_rules', 'gate_results',
    'variance_cases', 'approvals', 'payment_files', 'payslips', 'tax_filings',
    'credit_score_factors', 'credit_scores', 'credit_score_details',
    'lender_partners', 'data_sharing_consents', 'loan_referrals',
    'deduction_mandates', 'deduction_executions', 'lender_reconciliations',
    'loan_mirrors', 'audit_log'
  ]
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Tenant-scoped tables: the generic policy.
do $$
declare
  t text;
begin
  foreach t in array array[
    'subscriptions', 'billing_invoices', 'user_scopes',
    'departments', 'positions', 'employees', 'employee_bank_accounts',
    'employee_documents', 'employee_salary_history', 'pay_components',
    'payroll_policies', 'devices', 'shifts', 'shift_schedules', 'attendance_raw',
    'attendance_days', 'ot_requests', 'leave_types', 'leaves', 'leave_balances',
    'attendance_anomalies', 'payroll_runs', 'payroll_items', 'payroll_lines',
    'payroll_ot_lines', 'payroll_recalcs', 'gate_results', 'variance_cases',
    'approvals', 'payment_files', 'payslips', 'tax_filings', 'credit_scores',
    'credit_score_details', 'data_sharing_consents', 'loan_referrals',
    'deduction_mandates', 'deduction_executions', 'loan_mirrors'
  ]
  loop
    execute format(
      'create policy "tenant read %1$I" on %1$I for select to authenticated
         using (is_operator() or company_id = current_company_id())', t);
    execute format(
      'create policy "tenant write %1$I" on %1$I for insert to authenticated
         with check (is_operator() or company_id = current_company_id())', t);
    execute format(
      'create policy "tenant update %1$I" on %1$I for update to authenticated
         using (is_operator() or company_id = current_company_id())
         with check (is_operator() or company_id = current_company_id())', t);
    execute format(
      'create policy "operator delete %1$I" on %1$I for delete to authenticated
         using (is_operator())', t);
  end loop;
end $$;

-- companies: its own id is the tenant key, so it needs its own predicate.
create policy "read own company" on companies for select to authenticated
  using (is_operator() or id = current_company_id());
create policy "operator writes companies" on companies for all to authenticated
  using (is_operator()) with check (is_operator());

-- users: you can always see yourself; HR sees their company; the operator sees all.
create policy "read users" on users for select to authenticated
  using (is_operator() or id = auth.uid() or company_id = current_company_id());
create policy "manage users" on users for update to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin')))
  with check (is_operator() or (company_id = current_company_id() and has_role('hr_admin')));

-- Shared reference data: readable by anyone signed in, writable only by the
-- operator. Statutory rates are not a tenant's to edit.
do $$
declare
  t text;
begin
  foreach t in array array['plans', 'ot_rate_rules', 'bpjs_rates', 'tax_tables', 'umk_rates',
                           'gate_rules', 'credit_score_factors', 'lender_partners']
  loop
    execute format(
      'create policy "read reference %1$I" on %1$I for select to authenticated using (true)', t);
    execute format(
      'create policy "operator writes %1$I" on %1$I for all to authenticated
         using (is_operator()) with check (is_operator())', t);
  end loop;
end $$;

-- The employee app. Narrow additions on top of the tenant policies above:
-- a worker sees their own rows and nobody else's.
create policy "employee reads self" on employees for select to authenticated
  using (id = current_employee_id());
create policy "employee reads own payslip" on payroll_items for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own payslip lines" on payroll_lines for select to authenticated
  using (payroll_item_id in (select id from payroll_items where employee_id = current_employee_id()));
create policy "employee reads own attendance" on attendance_days for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own leave" on leaves for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own score" on credit_scores for select to authenticated
  using (employee_id = current_employee_id());

-- The lender portal. A partner sees the referrals and deductions they are
-- party to, and the scores of the people who consented — and nothing about
-- anyone's pay. The absence of a payroll_items policy for lenders is the
-- design: they are told what can be deducted, never what is earned.
create policy "lender reads own referrals" on loan_referrals for select to authenticated
  using (lender_id = current_lender_id());
create policy "lender reads own mandates" on deduction_mandates for select to authenticated
  using (lender_id = current_lender_id());
create policy "lender reads own executions" on deduction_executions for select to authenticated
  using (mandate_id in (select id from deduction_mandates where lender_id = current_lender_id()));
create policy "lender reads own reconciliations" on lender_reconciliations for select to authenticated
  using (is_operator() or lender_id = current_lender_id() or company_id = current_company_id());
-- Reconciliation rows are produced by the remittance job, which runs as the
-- operator; without this the table would be readable and never writable.
create policy "operator writes reconciliations" on lender_reconciliations for all to authenticated
  using (is_operator()) with check (is_operator());
create policy "lender reads consented scores" on credit_scores for select to authenticated
  using (employee_id in (
    select employee_id from data_sharing_consents
     where lender_id = current_lender_id() and revoked_at is null
  ));

-- audit_log: read by the operator, or by HR for their own company. No insert,
-- update or delete policy for anyone — log_audit is the only way in.
create policy "read audit" on audit_log for select to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin')));

-- ---------------------------------------------------------------------------
-- Consistency checks
-- ---------------------------------------------------------------------------
-- With no foreign keys, nothing stops a row from pointing at something that is
-- gone or at another tenant's record. These views find both. Run them before
-- closing each period; a non-empty result is a bug that has already been
-- written to disk.
--
-- The cross-tenant checks matter more than the orphan ones. An orphan line is
-- a broken payslip; a line whose employee belongs to another company is a
-- privacy breach that RLS will happily serve, because the row carries the
-- reader's own company_id.

create or replace view integrity_orphans as
  select 'payroll_items.employee_id' as ref, i.id as row_id, i.employee_id as missing_id
    from payroll_items i
    left join employees e on e.id = i.employee_id
   where e.id is null
  union all
  select 'payroll_lines.payroll_item_id', l.id, l.payroll_item_id
    from payroll_lines l
    left join payroll_items i on i.id = l.payroll_item_id
   where i.id is null
  union all
  select 'attendance_days.employee_id', a.id, a.employee_id
    from attendance_days a
    left join employees e on e.id = a.employee_id
   where e.id is null
  union all
  select 'deduction_executions.mandate_id', x.id, x.mandate_id
    from deduction_executions x
    left join deduction_mandates m on m.id = x.mandate_id
   where m.id is null;

create or replace view integrity_cross_tenant as
  select 'payroll_items vs employees' as ref, i.id as row_id
    from payroll_items i
    join employees e on e.id = i.employee_id
   where e.company_id <> i.company_id
  union all
  select 'payroll_items vs payroll_runs', i.id
    from payroll_items i
    join payroll_runs r on r.id = i.run_id
   where r.company_id <> i.company_id
  union all
  select 'attendance_days vs employees', a.id
    from attendance_days a
    join employees e on e.id = a.employee_id
   where e.company_id <> a.company_id
  union all
  select 'deduction_mandates vs employees', m.id
    from deduction_mandates m
    join employees e on e.id = m.employee_id
   where e.company_id <> m.company_id;
