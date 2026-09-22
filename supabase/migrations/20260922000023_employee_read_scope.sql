-- Part 23: stop an employee reading the whole company.
--
-- Part 9 gave every tenant-scoped table one read policy: company_id matches
-- the caller's. Part 9 then added narrow policies for an employee — their own
-- payslip, their own attendance — on the understanding that those were what an
-- employee got.
--
-- They were not. Policies are OR'd, an employee row carries a company_id, and
-- so the broad policy already matched everything. A worker signing into the
-- app could read every colleague's salary, bank account and credit score.
--
-- Found by listing every table as an employee account rather than by reading
-- the policies, which is the only way an accidental OR shows up: each policy
-- on its own is exactly what it looks like.
--
-- The fix is to make the broad policy mean what it was described as — access
-- for the people who run the company's payroll — and to let the narrow
-- policies be the whole of an employee's reach. Anything an employee
-- legitimately needs and did not already have is granted explicitly below.

-- ---------------------------------------------------------------------------
-- Staff, as distinct from the workforce
-- ---------------------------------------------------------------------------
create or replace function is_tenant_staff()
returns boolean as $$
  select exists (
    select 1 from users
     where id = auth.uid() and is_active and is_approved
       and role in ('hr_admin', 'payroll_staff', 'line_manager')
  );
$$ language sql security definer stable;

comment on function is_tenant_staff is
  'A tenant user who runs payroll. Excludes the employee role, whose access is
   the per-row policies only.';

-- ---------------------------------------------------------------------------
-- Rewrite the generic tenant policies
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'departments', 'positions', 'employees', 'employee_bank_accounts',
    'employee_documents', 'employee_salary_history',
    'pay_components', 'payroll_policies', 'devices', 'shifts', 'shift_schedules',
    'attendance_raw', 'attendance_days', 'ot_requests', 'leave_types', 'leaves',
    'leave_balances', 'attendance_anomalies', 'payroll_runs', 'payroll_items',
    'payroll_lines', 'payroll_ot_lines', 'payroll_recalcs', 'gate_results',
    'variance_cases', 'approvals', 'payment_files', 'payslips', 'tax_filings',
    'credit_scores', 'credit_score_details', 'data_sharing_consents',
    'loan_referrals', 'deduction_mandates', 'deduction_executions', 'loan_mirrors'
  ]
  loop
    execute format('drop policy if exists "tenant read %1$I" on %1$I', t);
    execute format('drop policy if exists "tenant write %1$I" on %1$I', t);
    execute format('drop policy if exists "tenant update %1$I" on %1$I', t);
    execute format(
      'create policy "staff read %1$I" on %1$I for select to authenticated
         using (is_operator() or (company_id = current_company_id() and is_tenant_staff()))', t);
    execute format(
      'create policy "staff write %1$I" on %1$I for insert to authenticated
         with check (is_operator() or (company_id = current_company_id() and is_tenant_staff()))', t);
    execute format(
      'create policy "staff update %1$I" on %1$I for update to authenticated
         using (is_operator() or (company_id = current_company_id() and is_tenant_staff()))
         with check (is_operator() or (company_id = current_company_id() and is_tenant_staff()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- What an employee legitimately needs and did not have
-- ---------------------------------------------------------------------------
-- Their own bank account, so the app can show which account their pay lands in.
-- The number itself is encrypted; this reads the last four.
create policy "employee reads own account" on employee_bank_accounts for select to authenticated
  using (employee_id = current_employee_id());

-- The run their payslip belongs to — period, pay date, whether it is final.
-- Without this the payslip screen cannot say what month it is for.
create policy "employee reads own runs" on payroll_runs for select to authenticated
  using (id in (select run_id from payroll_items where employee_id = current_employee_id()));

-- Leave type names, and the deduction ceiling their limit is computed from.
-- Both are company-wide settings rather than anybody's personal data.
create policy "employee reads leave types" on leave_types for select to authenticated
  using (company_id in (select company_id from employees where id = current_employee_id()));
create policy "employee reads payroll policy" on payroll_policies for select to authenticated
  using (company_id in (select company_id from employees where id = current_employee_id()));

-- The lender's book for their own loan, which is the balance the app shows.
create policy "employee reads own loan mirror" on loan_mirrors for select to authenticated
  using (employee_id = current_employee_id());

-- Their own consent records: who they let see their profile, and whether it is
-- still live. A consent somebody cannot inspect is not one they can withdraw.
create policy "employee reads own consents" on data_sharing_consents for select to authenticated
  using (employee_id = current_employee_id());

-- ---------------------------------------------------------------------------
-- The user directory
-- ---------------------------------------------------------------------------
-- Part 9 let any tenant user read every user row in the company — names,
-- emails and roles. Narrowed to staff and to the caller's own row; the
-- colleague directory in the mockup needs its own decision about what is
-- shown, and until that decision exists the answer is nothing.
drop policy if exists "read users" on users;
create policy "read users" on users for select to authenticated
  using (is_operator() or id = auth.uid() or (company_id = current_company_id() and is_tenant_staff()));
