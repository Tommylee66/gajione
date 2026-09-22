-- Part 14: the attendance device integration.
--
-- Devices already existed; how they are reached did not. The endpoint, the
-- credential and the polling interval are what turn a list of device rows into
-- an attendance source, and G1 reads what this brings in — so a sync that
-- silently did nothing has to be distinguishable from one that worked.

create table device_integrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  endpoint_url text,
  auth_method varchar(20) not null default 'api_key'
    check (auth_method in ('api_key', 'oauth2')),
  -- Encrypted with the application key, never stored in plaintext. A device
  -- API key reaches every punch record in the company, so a database dump
  -- alone must not yield it.
  credential_encrypted jsonb,
  -- Last four characters, for the screen to show which key is configured
  -- without revealing it.
  credential_hint varchar(8),
  polling_minutes integer not null default 15
    check (polling_minutes in (5, 15, 30, 60)),
  webhook_url text,
  last_full_sync_at timestamptz,
  -- Set from the outcome of the last attempt rather than by hand: a status
  -- somebody types is a claim, not an observation.
  last_status varchar(20) not null default 'unknown'
    check (last_status in ('unknown', 'ok', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id)
);

-- Every attempt, successful or not. "The device was offline that morning" is
-- the answer to a missing punch, and it can only be given if the failure was
-- recorded at the time.
create table device_sync_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  device_id uuid,                                -- null = full sync
  kind varchar(20) not null check (kind in ('full', 'device', 'webhook')),
  status varchar(20) not null check (status in ('success', 'failed', 'partial')),
  record_count integer not null default 0,
  duration_ms integer,
  detail text,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index device_sync_logs_company_idx on device_sync_logs (company_id, started_at desc);
create index device_sync_logs_device_idx on device_sync_logs (device_id, started_at desc);

alter table device_integrations enable row level security;
alter table device_sync_logs enable row level security;

create policy "read device_integrations" on device_integrations for select to authenticated
  using (is_operator() or company_id = current_company_id());
create policy "write device_integrations" on device_integrations for all to authenticated
  using (is_operator() or (company_id = current_company_id() and has_role('hr_admin')))
  with check (is_operator() or (company_id = current_company_id() and has_role('hr_admin')));

create policy "read device_sync_logs" on device_sync_logs for select to authenticated
  using (is_operator() or company_id = current_company_id());
create policy "write device_sync_logs" on device_sync_logs for all to authenticated
  using (is_operator() or company_id = current_company_id())
  with check (is_operator() or company_id = current_company_id());

-- One row per company so the screen has something to edit rather than a
-- create-then-edit step for a record there can only ever be one of.
insert into device_integrations (company_id)
select id from companies
on conflict (company_id) do nothing;
