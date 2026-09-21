-- Part 10: reference data the system cannot start without.
--
-- Everything here is taken from what the mockups state on screen, with the
-- legal citation they print beside it. Where a mockup gives a figure, it is
-- seeded. Where it does not, the row is absent rather than guessed — a payroll
-- system with a plausible-looking wrong rate is worse than one that refuses to
-- run, because the wrong rate ships 412 payslips before anybody notices.
--
-- ⚠️ Confirm every figure below with the company's accountant before the first
-- live run. These are the prototype's numbers, not tax advice, and several of
-- them change annually.

-- ---------------------------------------------------------------------------
-- Overtime multipliers — Kepmenakertrans 102/2004
-- ---------------------------------------------------------------------------
-- company_id null: statutory, shared by every tenant. A company that has
-- agreed better terms gets its own rows and those win.
insert into ot_rate_rules (company_id, day_type, from_hour, to_hour, multiplier, multiplier_max, legal_basis, effective_from) values
  (null, 'weekday', 0, 1,    1.5, null, 'Kepmenakertrans 102/2004', '2004-10-25'),
  (null, 'weekday', 1, null, 2.0, null, 'Kepmenakertrans 102/2004', '2004-10-25'),
  -- The mockup prints this band as a range. multiplier holds the floor and
  -- multiplier_max the ceiling; the rule that picks a point between them is
  -- still open, so a run that lands here should stop and ask rather than
  -- quietly take 2.0.
  (null, 'holiday', 0, 8,    2.0, 3.0,  'Kepmenakertrans 102/2004', '2004-10-25'),
  (null, 'holiday', 8, null, 4.0, null, 'Kepmenakertrans 102/2004', '2004-10-25');

-- ---------------------------------------------------------------------------
-- BPJS — employee-side rates as printed in the mockup
-- ---------------------------------------------------------------------------
-- "Kesehatan 1% · JHT 2% · JP 1%(상한 적용), 회사부담 JKK 0.89%(제조업 요율)"
--
-- Only these four appear on screen. The employer shares of Kesehatan, JHT and
-- JP, the JKM rate, and the JP wage cap are all real obligations that the
-- mockup does not quote, so they are left out: seeding a number nobody can
-- point at is how a wrong figure becomes permanent. Add them with their source
-- before the first run.
insert into bpjs_rates (program, employee_rate, employer_rate, wage_cap, risk_class, version, effective_from) values
  ('kesehatan', 0.0100, 0,      null, null,            'MOCKUP-2026.1', '2026-01-01'),
  ('jht',       0.0200, 0,      null, null,            'MOCKUP-2026.1', '2026-01-01'),
  -- wage_cap null is a gap, not a decision: JP is capped, and without the cap
  -- the deduction runs away at the top of the payroll.
  ('jp',        0.0100, 0,      null, null,            'MOCKUP-2026.1', '2026-01-01'),
  ('jkk',       0,      0.0089, null, 'manufacturing', 'MOCKUP-2026.1', '2026-01-01');

-- ---------------------------------------------------------------------------
-- Minimum wage
-- ---------------------------------------------------------------------------
-- The mockup checks against Bekasi at 5.69M. UMK is set per regency and
-- revised every year, so this is one row of a table that needs filling for
-- wherever else the customer operates.
insert into umk_rates (region, amount, year, effective_from) values
  ('Bekasi', 5690000, 2026, '2026-01-01');

-- ---------------------------------------------------------------------------
-- PPh 21
-- ---------------------------------------------------------------------------
-- Deliberately empty. The mockup tags its run `TER-2026.1` but never shows the
-- brackets, and the TER table is ~40 rows across three categories that decide
-- what every employee actually takes home. Load it from the PMK 168/2023
-- schedule before the first run; until then G2 has nothing to compute tax with,
-- which is the correct failure.

-- ---------------------------------------------------------------------------
-- Quality gate rules
-- ---------------------------------------------------------------------------
-- The mockup runs 14 rules and passes 12. These are the ones it names on
-- screen, with the severity its behaviour implies: the run advances past G2
-- with warnings outstanding but stops at G3 with two explanations pending.
insert into gate_rules (company_id, code, gate, name, description, severity, threshold, legal_basis) values
  (null, 'G1_DEVICE_SYNC',    'G1', '지문기 동기화',     '모든 근태 장치가 컷오프 시점에 동기화되어 있어야 함', 'blocking', null, null),
  (null, 'G1_ANOMALY_CLEAR',  'G1', '이상근태 전건 해결', '미해결 이상근태가 남아 있으면 마감 불가',            'blocking', null, null),
  (null, 'G1_OT_PREAPPROVED', 'G1', 'OT 사전승인 100%',  '근무 전에 승인되지 않은 초과근무가 없어야 함',        'blocking', null, null),
  (null, 'G1_WEEKLY_OT_CAP',  'G1', '주간 OT 상한',      '주 18시간 초과 시 특별승인 필요',                    'warning',  1080, 'UU 13/2003'),
  (null, 'G2_UMK_FLOOR',      'G2', 'UMK 미달 검사',     '지역 최저임금 미달자가 없어야 함',                    'blocking', null, 'UMK 규정'),
  (null, 'G2_RECALC_MATCH',   'G2', '병렬 재계산 일치',   '두 번의 독립 계산이 같은 배치 해시를 내야 함',        'blocking', null, null),
  (null, 'G2_RATE_VERSION',   'G2', '요율 버전 고정',     '차수가 사용한 세율·BPJS 버전이 기록되어 있어야 함',   'blocking', null, null),
  (null, 'G3_NET_VARIANCE',   'G3', '순지급 변동 검출',   '전월 대비 ±20% 초과자는 소명 후 승인 필요',          'blocking', 20,   null),
  (null, 'G3_LOAN_CAP',       'G3', '대출 공제 상한',     '월 공제액이 실지급액의 30%를 넘지 않아야 함',         'blocking', 30,   null),
  (null, 'G4_SEQUENTIAL_SIGN','G4', '순차 전자서명',      '급여담당→HR장→법인장 순서로만 서명 가능, 위임 불가',  'blocking', null, null);

-- ---------------------------------------------------------------------------
-- Credit scoring
-- ---------------------------------------------------------------------------
-- 850 total: a fixed 300 base plus 550 distributed by weight. The mockup's
-- worked example (92/88/84/78 normalised → 152/121/116/86, total 775) comes
-- back out of these exactly.
insert into credit_score_factors (code, name, weight, max_points, source, effective_from) values
  ('attendance', '출근율·근태규칙성', 30, 165.00, '근태마감(G1) 확정데이터',  '2026-01-01'),
  ('repayment',  '상환이력',         25, 137.50, '대출상환원장',            '2026-01-01'),
  ('tenure',     '근속·고용형태',     25, 137.50, '인사마스터',              '2026-01-01'),
  ('pay_stability','급여안정성',      20, 110.00, '급여계산(G2) 이력',       '2026-01-01');

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------
-- Names and shape from the operator console. Amounts are placeholders — the
-- console shows a computed monthly bill, not the rate card behind it.
insert into plans (code, name, base_fee, per_employee_fee, whitelabel_fee, active) values
  ('starter',    'Starter',    0, 0, 0, true),
  ('business',   'Business',   0, 0, 0, true),
  ('enterprise', 'Enterprise', 0, 0, 0, true);
