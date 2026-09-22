-- Part 19: the scoring curves, out of the code and into the table.
--
-- Where a score falls for a point of absenteeism, what a year of tenure is
-- worth, how much a single late repayment costs — these are credit-risk
-- decisions. They were hardcoded and marked provisional, which meant the only
-- way to set them was a deployment, and the only person who could was an
-- engineer. Neither is right for a number somebody is refused a loan on.
--
-- One jsonb per factor rather than a shared shape, because the factors are not
-- the same shape: attendance is a line, repayment is a step, tenure accrues
-- per year. A single generic curve would fit none of them.
--
-- Seeded with exactly the values the code used, so this migration changes no
-- score. What it changes is who can change them.
alter table credit_score_factors add column curve jsonb not null default '{}';

update credit_score_factors set curve = '{
  "zero_at_percent": 0,
  "absence_penalty": 5
}'::jsonb where code = 'attendance';

update credit_score_factors set curve = '{
  "no_history": 60,
  "base": 70,
  "per_completed": 10,
  "max_completed": 3,
  "late_penalty": 30
}'::jsonb where code = 'repayment';

update credit_score_factors set curve = '{
  "per_year": 18,
  "years_cap": 90,
  "permanent_bonus": 10,
  "probation_scores_zero": true
}'::jsonb where code = 'tenure';

update credit_score_factors set curve = '{
  "cv_multiplier": 400,
  "min_months": 2,
  "insufficient_score": 50
}'::jsonb where code = 'pay_stability';

comment on column credit_score_factors.curve is
  'Normalisation parameters for this factor. Shape differs per factor code; see lib/credit/curves.ts.';
