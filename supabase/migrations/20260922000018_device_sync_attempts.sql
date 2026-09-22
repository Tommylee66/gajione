-- Part 18: when the poll was last attempted, not last succeeded.
--
-- The scheduler decides what is due from this column. Using last_full_sync_at
-- would make a failing endpoint due on every tick forever — the one case where
-- a fixed interval matters most, because that is a device nobody has noticed
-- is down.
alter table device_integrations
  add column last_attempt_at timestamptz,
  -- Set when polling should stop until somebody looks. Consecutive failures
  -- are counted rather than assumed: one timed-out request is a network blip,
  -- twenty in a row is an endpoint that has moved.
  add column consecutive_failures integer not null default 0,
  add column auto_poll boolean not null default true;

comment on column device_integrations.auto_poll is
  'false disables scheduled polling; the manual buttons still work';
