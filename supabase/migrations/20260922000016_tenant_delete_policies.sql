-- Part 16: let tenants clear what they are allowed to redo.
--
-- Part 9 gave DELETE on every tenant-scoped table to the operator alone. That
-- is right for records a company must not be able to erase — a payslip, an
-- approval, an audit entry — but it also caught the working tables that normal
-- operations rewrite: recomputing a run, re-evaluating G3, re-importing
-- attendance, redrawing a shift roster.
--
-- The failure mode is the reason this is worth a migration rather than a
-- workaround. RLS filters a DELETE instead of failing it, so those statements
-- removed zero rows and reported success. Re-evaluating G3 appended a second
-- copy of every rule; recomputing a run failed afterwards on a duplicate-key
-- violation that named nothing anybody could act on. Both looked like bugs
-- somewhere else entirely.
--
-- Each policy below is narrowed twice: to the roles that perform the
-- operation, and to the state in which redoing it is still legitimate. Nothing
-- here lets a tenant delete a locked run's figures, a distributed payslip, an
-- approval or an audit entry.

-- --- Recomputing a run -------------------------------------------------------
-- Only while the run is open. Once it is locked its figures have been paid
-- against and filed on, and the way to change them is a correction run.
create policy "tenant clears payroll_items" on payroll_items for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff')
    and run_id in (
      select id from payroll_runs
       where company_id = current_company_id()
         and locked_at is null
         and status <> 'locked'
    )
  );

-- payroll_lines and payroll_ot_lines cascade from the item, so they need no
-- policy of their own — but payroll_recalcs does not, and a second pass would
-- otherwise compare against a stale first pass.
create policy "tenant clears payroll_recalcs" on payroll_recalcs for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff')
    and run_id in (
      select id from payroll_runs
       where company_id = current_company_id()
         and locked_at is null
         and status <> 'locked'
    )
  );

-- --- Re-evaluating G3 --------------------------------------------------------
create policy "tenant clears gate_results" on gate_results for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff')
    and run_id in (
      select id from payroll_runs
       where company_id = current_company_id()
         and locked_at is null
         and status <> 'locked'
    )
  );

-- Only cases nobody has written on. An explanation or an HR decision is
-- somebody's judgement on the record, and re-running the rules must not erase
-- it — the evaluate action already filters to 'pending', and this makes that
-- filter a guarantee rather than a convention.
create policy "tenant clears pending variance_cases" on variance_cases for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff')
    and status = 'pending'
    and line_submitted_at is null
  );

-- --- Filing drafts -----------------------------------------------------------
-- Drafts only. A submitted filing has a receipt number from the tax office.
create policy "tenant clears draft tax_filings" on tax_filings for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff')
    and status = 'draft'
  );

-- --- Attendance and rosters --------------------------------------------------
-- Open anomalies are rebuilt on every import. A resolved or waived one carries
-- somebody's decision and stays.
create policy "tenant clears open anomalies" on attendance_anomalies for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff', 'line_manager')
    and status = 'open'
  );

-- The roster is a plan until the days it covers are confirmed. The action
-- already refuses to clear a range containing confirmed attendance; this makes
-- the database agree.
create policy "tenant clears shift_schedules" on shift_schedules for delete to authenticated
  using (
    company_id = current_company_id()
    and has_role('hr_admin', 'payroll_staff', 'line_manager')
    and not exists (
      select 1 from attendance_days d
       where d.employee_id = shift_schedules.employee_id
         and d.work_date = shift_schedules.work_date
         and d.is_confirmed
    )
  );
