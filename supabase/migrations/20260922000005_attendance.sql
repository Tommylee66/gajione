-- Part 5: G1, attendance.
--
-- The split that matters here is attendance_raw against attendance_days. The
-- first is what a device reported; the second is what payroll will be paid
-- from. Keeping them apart is what lets the mockup's cases be resolved without
-- destroying the evidence:
--
--   "지문기#7 로그 보정 · CCTV 교차확인 — 야간교대 퇴근기록 누락"
--
-- The raw punch stays missing forever. The day row gets a check-out and a note
-- saying who decided that and on what basis. Overwrite the raw record instead
-- and the company has no answer when the worker disputes the month.

create table devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code varchar(40) not null,
  name varchar(255),
  device_type varchar(20) not null default 'fingerprint' check (device_type in ('fingerprint', 'mobile', 'card', 'face')),
  location varchar(255),
  last_sync_at timestamptz,
  status varchar(20) not null default 'active' check (status in ('active', 'offline', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);
create index devices_company_idx on devices (company_id);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  name varchar(100) not null,
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0,
  -- A night shift ends on the following calendar day, so the day-building step
  -- has to know before it can pair punches.
  crosses_midnight boolean not null default false,
  is_night boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shifts_company_idx on shifts (company_id);

-- Which shift a person is rostered on, per day. The mockup runs a three-group
-- two-shift rotation, so this cannot be derived from a weekday rule.
create table shift_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  work_date date not null,
  shift_id uuid,
  rotation_group varchar(20),
  created_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index shift_schedules_company_date_idx on shift_schedules (company_id, work_date);

-- Append only. Nothing in the application updates or deletes a row here.
create table attendance_raw (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  device_id uuid,
  punched_at timestamptz not null,
  direction varchar(10) not null check (direction in ('in', 'out')),
  gps_lat numeric(10,7),
  gps_lng numeric(10,7),
  source varchar(20) not null default 'device' check (source in ('device', 'mobile', 'manual', 'import')),
  raw_payload jsonb,
  created_at timestamptz not null default now()
);
create index attendance_raw_employee_idx on attendance_raw (employee_id, punched_at);
create index attendance_raw_company_idx on attendance_raw (company_id, punched_at);

-- The interpreted day. is_confirmed is the G1 gate: payroll reads only
-- confirmed rows, and confirming is what closes the period for attendance.
create table attendance_days (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  work_date date not null,
  shift_id uuid,
  check_in timestamptz,
  check_out timestamptz,
  work_minutes integer not null default 0,
  late_minutes integer not null default 0,
  early_leave_minutes integer not null default 0,
  ot_minutes integer not null default 0,
  night_minutes integer not null default 0,
  status attendance_status not null default 'present',
  -- Set when a value here does not follow from the raw punches, with the
  -- reason. This is the audit trail for every manual correction.
  adjusted_by uuid,
  adjusted_at timestamptz,
  adjustment_reason text,
  is_confirmed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index attendance_days_company_date_idx on attendance_days (company_id, work_date);
create index attendance_days_confirmed_idx on attendance_days (company_id, work_date, is_confirmed);

-- Overtime has to be approved before it is worked — the mockup makes "OT
-- 사전승인 100%" a G1 pass condition. Keeping approvals in their own table with
-- their own timestamp is what makes that checkable; a flag on the day row
-- could always have been set afterwards.
create table ot_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  work_date date not null,
  planned_minutes integer not null,
  actual_minutes integer,
  reason text,
  -- Set when the week's total passes the 18h cap and a special approval was
  -- obtained (UU 13/2003).
  over_weekly_cap boolean not null default false,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  status approval_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ot_requests_employee_date_idx on ot_requests (employee_id, work_date);
create index ot_requests_company_status_idx on ot_requests (company_id, status);

create table leave_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code varchar(40) not null,
  name varchar(100) not null,
  is_paid boolean not null default true,
  annual_quota numeric(5,1),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table leaves (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  leave_type_id uuid not null,
  start_date date not null,
  end_date date not null,
  days numeric(5,1) not null,
  reason text,
  status approval_status not null default 'pending',
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leaves_employee_idx on leaves (employee_id, start_date desc);
create index leaves_company_status_idx on leaves (company_id, status);

create table leave_balances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  leave_type_id uuid not null,
  year integer not null,
  entitled numeric(5,1) not null default 0,
  used numeric(5,1) not null default 0,
  carried_over numeric(5,1) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, leave_type_id, year)
);
create index leave_balances_company_idx on leave_balances (company_id, year);

-- One row per thing that looked wrong, and what was done about it. G1 does not
-- pass while any of these is unresolved.
create table attendance_anomalies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  work_date date not null,
  anomaly_type varchar(60) not null,             -- 지각 미소명 / 퇴근기록 누락 / 연차·출근 중복 …
  detail text,
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  status varchar(20) not null default 'open' check (status in ('open', 'resolved', 'waived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index attendance_anomalies_company_idx on attendance_anomalies (company_id, status, work_date);
