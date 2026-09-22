-- Part 25: whether a subscription is paid annually in advance.
--
-- The pricing screen sets an annual-prepayment discount per plan, and the
-- invoice builder takes a flag for whether it applies. The subscription had
-- nowhere to record that, which left the flag with nothing to read and the
-- discount unreachable — a price the console could set and never charge.
alter table subscriptions
  add column annual_prepay boolean not null default false;

comment on column subscriptions.annual_prepay is
  'Paid a year in advance; the plan''s annual_prepay_discount then applies.';
