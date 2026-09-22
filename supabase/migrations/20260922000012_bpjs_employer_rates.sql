-- Part 12: the BPJS figures that were left blank.
--
-- 20260922000010 seeded only the employee-side rates and noted that the
-- employer shares and wage caps were absent because no mockup quoted them.
-- That was wrong: the policy screen in app.html carries the full table, and
-- the seed was written from the payslip breakdown alone.
--
--   Kesehatan  1%  employee   4%   employer   capped at 12,000,000
--   JHT        2%             3.7%            no cap
--   JP         1%             2%              capped at 10,200,000
--   JKK        —              0.89%           manufacturing risk class
--
-- The caps matter as much as the rates. Without them the deduction keeps
-- scaling at the top of the payroll, and a manager on 20M has Kesehatan
-- withheld on the full amount instead of on 12M.
--
-- Superseding rather than editing: the 2026-01-01 rows stay as they were so
-- any run that already read them still reconciles, and these take effect from
-- the same date under a new version tag. Nothing has run against the old rows
-- yet, but establishing the pattern here is cheaper than remembering it later.

update bpjs_rates
   set effective_to = '2025-12-31'
 where version = 'MOCKUP-2026.1';

insert into bpjs_rates (program, employee_rate, employer_rate, wage_cap, risk_class, version, effective_from) values
  ('kesehatan', 0.0100, 0.0400, 12000000, null,            'BPJS-2026.1', '2026-01-01'),
  ('jht',       0.0200, 0.0370, null,     null,            'BPJS-2026.1', '2026-01-01'),
  ('jp',        0.0100, 0.0200, 10200000, null,            'BPJS-2026.1', '2026-01-01'),
  ('jkk',       0,      0.0089, null,     'manufacturing', 'BPJS-2026.1', '2026-01-01');

-- JKM is the fifth programme and the policy screen does not list it. Left out
-- deliberately rather than filled in from memory — the same rule that produced
-- the gap this migration is fixing.

-- The policy screen also names DKI Jakarta, Karawang, Bandung and Surabaya,
-- but with empty amount fields — they are inputs on the mockup, not values.
--
-- They are NOT seeded. A row with amount 0 would make the minimum-wage check
-- pass every employee in that region, which is worse than having no row at
-- all: the gate would report a clean result while checking nothing. The G2
-- check must treat a missing UMK for an employee's region as a blocking
-- failure rather than a skip, and the policy screen is where the figures get
-- entered before a run covers anyone working there.
