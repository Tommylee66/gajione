-- Part 15: the source-data upload.
--
-- The PPh 21 template is how a company's payroll inputs arrive before anything
-- is calculated. Batches are kept rather than parsed and discarded because
-- "what did we upload for August" is asked months later, usually by somebody
-- reconciling a filed figure against a payslip.

create table upload_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period char(7) not null,                       -- 'YYYY-MM'
  filename varchar(255),
  uploaded_by uuid,
  row_count integer not null default 0,
  error_count integer not null default 0,
  -- 'parsed' has been validated and not yet applied; 'applied' has been
  -- written onto the employee master. A batch with errors can never be
  -- applied, so the two are not the same as "has errors".
  status varchar(20) not null default 'parsed'
    check (status in ('parsed', 'applied', 'discarded')),
  applied_at timestamptz,
  applied_by uuid,
  -- What applying it actually changed, so the count on the screen is the count
  -- that happened rather than the count that was predicted.
  created_employees integer not null default 0,
  updated_employees integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index upload_batches_company_idx on upload_batches (company_id, created_at desc);

-- Every row as it arrived, plus what was wrong with it. Held verbatim so a
-- disputed figure can be checked against the file that was submitted, not
-- against our reading of it.
create table upload_rows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  batch_id uuid not null,
  row_no integer not null,
  employee_number varchar(40),
  data jsonb not null,
  errors jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index upload_rows_batch_idx on upload_rows (batch_id, row_no);

alter table upload_batches enable row level security;
alter table upload_rows enable row level security;

create policy "read upload_batches" on upload_batches for select to authenticated
  using (is_operator() or company_id = current_company_id());
create policy "write upload_batches" on upload_batches for all to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin', 'payroll_staff')))
  with check (is_operator() or (company_id = current_company_id() and has_role('hr_admin', 'payroll_staff')));

create policy "read upload_rows" on upload_rows for select to authenticated
  using (is_operator() or company_id = current_company_id());
create policy "write upload_rows" on upload_rows for all to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin', 'payroll_staff')))
  with check (is_operator() or (company_id = current_company_id() and has_role('hr_admin', 'payroll_staff')));
