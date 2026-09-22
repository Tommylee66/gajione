-- Part 11: foreign keys, selectively.
--
-- The original rule was "no foreign keys". Building the employee screens
-- against it produced enough friction to change the rule:
--
--   * PostgREST resolves embedded selects (`departments(name)`) through
--     foreign keys. Without them the first list render failed outright, and
--     every list view has to fetch lookup tables separately and join in
--     memory — a cost that repeats on every screen, forever.
--   * Nothing stopped a row pointing at a deleted parent, so an orphan check
--     had to become an operating procedure. That is a foreign key, run by
--     hand, late.
--
-- So the rule is now "where it protects money and identity", not "nowhere".
-- Added here, with `on delete restrict` throughout — deletion of a referenced
-- master row should fail loudly rather than cascade through a payroll ledger.
--
-- Deliberately still absent:
--
--   * Audit-ish user references (created_by, approved_by, requested_by,
--     resolved_by, adjusted_by, hr_approver_id …). Who signed something has to
--     survive their account being removed; a constraint here would either
--     block the removal or erase the record of who acted.
--   * departments.parent_id. Self-referencing, and the management screen is
--     built to keep showing rows whose parent has gone.
--   * lender_ref_no and other keys owned by an external system.
--
-- Triggers remain out entirely. updated_at is still set by the caller and
-- audit rows still go through log_audit — neither has caused any trouble, and
-- explicit writes read better than action at a distance.
--
-- Cheap to run now: the database holds three demo employees. After a year of
-- payroll it would mean cleaning orphans first, which is its own project.

-- ---------------------------------------------------------------------------
-- Tenant key
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'subscriptions', 'billing_invoices', 'user_scopes', 'departments', 'positions',
    'employees', 'employee_bank_accounts', 'employee_documents',
    'employee_salary_history', 'pay_components', 'payroll_policies', 'devices',
    'shifts', 'shift_schedules', 'attendance_raw', 'attendance_days',
    'ot_requests', 'leave_types', 'leaves', 'leave_balances',
    'attendance_anomalies', 'payroll_runs', 'payroll_items', 'payroll_lines',
    'payroll_ot_lines', 'payroll_recalcs', 'gate_results', 'variance_cases',
    'approvals', 'payment_files', 'payslips', 'tax_filings', 'credit_scores',
    'credit_score_details', 'data_sharing_consents', 'loan_referrals',
    'deduction_mandates', 'deduction_executions', 'loan_mirrors',
    'lender_reconciliations'
  ]
  loop
    execute format(
      'alter table %1$I add constraint %1$I_company_fk
         foreign key (company_id) references companies(id) on delete restrict', t);
    -- Postgres indexes the referenced side, never the referencing one, so the
    -- index still has to be ours. Most already exist from the original
    -- migrations; this fills the gaps without duplicating them.
    execute format('create index if not exists %1$I_company_id_idx on %1$I (company_id)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'employee_bank_accounts', 'employee_documents', 'employee_salary_history',
    'shift_schedules', 'attendance_raw', 'attendance_days', 'ot_requests',
    'leaves', 'leave_balances', 'attendance_anomalies', 'payroll_items',
    'variance_cases', 'payslips', 'credit_scores', 'data_sharing_consents',
    'loan_referrals', 'deduction_mandates', 'loan_mirrors'
  ]
  loop
    execute format(
      'alter table %1$I add constraint %1$I_employee_fk
         foreign key (employee_id) references employees(id) on delete restrict', t);
    execute format('create index if not exists %1$I_employee_id_idx on %1$I (employee_id)', t);
  end loop;
end $$;

-- An employee's department and position. restrict is what makes the
-- management screen's "deactivate, never delete" rule enforceable rather than
-- merely advised.
alter table employees add constraint employees_department_fk
  foreign key (department_id) references departments(id) on delete restrict;
alter table employees add constraint employees_position_fk
  foreign key (position_id) references positions(id) on delete restrict;
alter table user_scopes add constraint user_scopes_department_fk
  foreign key (department_id) references departments(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'payroll_items', 'payroll_recalcs', 'gate_results', 'variance_cases',
    'approvals', 'payment_files', 'tax_filings', 'deduction_executions'
  ]
  loop
    execute format(
      'alter table %1$I add constraint %1$I_run_fk
         foreign key (run_id) references payroll_runs(id) on delete restrict', t);
    execute format('create index if not exists %1$I_run_id_idx on %1$I (run_id)', t);
  end loop;
end $$;

-- Payslip lines belong to one payslip. Cascade here, and only here: a payroll
-- item and its lines are one document, and a half-deleted payslip is worse
-- than either outcome.
alter table payroll_lines add constraint payroll_lines_item_fk
  foreign key (payroll_item_id) references payroll_items(id) on delete cascade;
alter table payroll_ot_lines add constraint payroll_ot_lines_item_fk
  foreign key (payroll_item_id) references payroll_items(id) on delete cascade;
alter table payslips add constraint payslips_item_fk
  foreign key (payroll_item_id) references payroll_items(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
alter table attendance_raw add constraint attendance_raw_device_fk
  foreign key (device_id) references devices(id) on delete restrict;
alter table attendance_days add constraint attendance_days_shift_fk
  foreign key (shift_id) references shifts(id) on delete restrict;
alter table shift_schedules add constraint shift_schedules_shift_fk
  foreign key (shift_id) references shifts(id) on delete restrict;
alter table leaves add constraint leaves_type_fk
  foreign key (leave_type_id) references leave_types(id) on delete restrict;
alter table leave_balances add constraint leave_balances_type_fk
  foreign key (leave_type_id) references leave_types(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- Lending
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'data_sharing_consents', 'loan_referrals', 'deduction_mandates',
    'lender_reconciliations', 'loan_mirrors'
  ]
  loop
    execute format(
      'alter table %1$I add constraint %1$I_lender_fk
         foreign key (lender_id) references lender_partners(id) on delete restrict', t);
    execute format('create index if not exists %1$I_lender_id_idx on %1$I (lender_id)', t);
  end loop;
end $$;

alter table deduction_executions add constraint deduction_executions_mandate_fk
  foreign key (mandate_id) references deduction_mandates(id) on delete restrict;
alter table credit_score_details add constraint credit_score_details_score_fk
  foreign key (credit_score_id) references credit_scores(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
alter table subscriptions add constraint subscriptions_plan_fk
  foreign key (plan_id) references plans(id) on delete restrict;
alter table user_scopes add constraint user_scopes_user_fk
  foreign key (user_id) references users(id) on delete cascade;
alter table users add constraint users_company_fk
  foreign key (company_id) references companies(id) on delete restrict;
alter table users add constraint users_employee_fk
  foreign key (employee_id) references employees(id) on delete restrict;
alter table users add constraint users_lender_fk
  foreign key (lender_id) references lender_partners(id) on delete restrict;
