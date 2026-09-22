-- Part 17: the real 2026 minimum wages, and the BPJS programme that was missing.
--
-- Both were placeholders the seed comments admitted to. A UMK that is close but
-- wrong fails the G2 floor check in the wrong direction, and a missing BPJS
-- programme understates the employer's cost without touching a payslip — which
-- is the harder kind of gap to notice.

-- ---------------------------------------------------------------------------
-- UMK 2026
-- ---------------------------------------------------------------------------
-- Figures as published for 2026, in force from 1 January 2026. Karawang is
-- quoted to the sen; the column is numeric(18,2) and keeps it rather than
-- rounding a legal minimum down.
--
-- 'Bekasi' is removed because it was ambiguous as well as wrong: Kota Bekasi
-- and Kabupaten Bekasi are different figures (5.99M against 5.94M), and a
-- region string that does not say which one silently picks a side. Both are
-- listed now, so the choice has to be made on the employee record where it
-- belongs.
delete from umk_rates where region = 'Bekasi' and year = 2026;

insert into umk_rates (region, amount, year, effective_from) values
  ('DKI Jakarta',        5729876.00,  2026, '2026-01-01'),
  ('Kabupaten Bekasi',   5938885.00,  2026, '2026-01-01'),
  ('Kota Bekasi',        5992931.93,  2026, '2026-01-01'),
  ('Kabupaten Karawang', 5886852.34,  2026, '2026-01-01'),
  ('Kota Bandung',       4737678.00,  2026, '2026-01-01'),
  ('Kota Surabaya',      5288796.00,  2026, '2026-01-01')
on conflict (region, year) do update
  set amount = excluded.amount, effective_from = excluded.effective_from;

-- Anything still pointing at the ambiguous name is moved to Kabupaten Bekasi —
-- the industrial side (Cikarang), which is where a metal-pressing plant sits.
-- One UPDATE away from Kota Bekasi if a given site is actually in the city.
update companies set umk_region = 'Kabupaten Bekasi' where umk_region = 'Bekasi';
update employees set umk_region = 'Kabupaten Bekasi' where umk_region = 'Bekasi';

-- ---------------------------------------------------------------------------
-- BPJS JKM
-- ---------------------------------------------------------------------------
-- Jaminan Kematian: 0.30% of monthly wage, borne entirely by the employer
-- (PP 44/2015). It was left out of the seed rather than set wrong, because the
-- mockup's policy screen does not show it.
--
-- Added to the version already in force rather than opened as a new one: the
-- employee rate is zero, the calculation skips programmes with no employee
-- share, so no payslip figure moves and no past run's numbers change. What it
-- corrects is the employer cost, which was understated by 0.30% of the
-- contributable wage for every employee.
insert into bpjs_rates (program, employee_rate, employer_rate, wage_cap, risk_class, version, effective_from, effective_to)
select 'jkm', 0, 0.0030, null, null, 'BPJS-2026.1', '2026-01-01', null
where not exists (
  select 1 from bpjs_rates where program = 'jkm' and version = 'BPJS-2026.1'
);
