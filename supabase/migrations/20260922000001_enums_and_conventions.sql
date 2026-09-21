-- GajiOne schema, part 1: enums and the conventions the rest of it follows.
--
-- Two decisions shape every file after this one.
--
-- No foreign keys, no triggers. References are plain uuid columns. Nothing
-- fires on write: `updated_at` is set by the caller, audit rows are written by
-- an explicit RPC, and nothing cascades. What the database still enforces is
-- primary keys, unique constraints, check constraints and RLS — none of which
-- are foreign keys or triggers, and all of which we rely on.
--
-- The cost is orphan rows: a payroll line can outlive the employee it names,
-- and nothing will stop it. Payroll is money and statutory evidence, so the
-- consistency-check queries at the end of the last migration are an operating
-- procedure, not an optional extra. Run them before each period closes.
--
-- Money is `numeric(18,2)`, never float. Rupiah is quoted in whole units but
-- the rates that produce it are not — BPJS at 1%, overtime at 1/173 of a
-- monthly salary, a mid-month joiner's prorated allowance. Accumulating those
-- in binary floating point puts the company's total a few rupiah away from the
-- sum of its payslips, which is exactly the number a tax auditor recomputes.

create extension if not exists "pgcrypto";

-- Who a login is. A user is either the operator (GajiOne staff), somebody at a
-- customer company, or an external lender's staff — see users.company_id and
-- users.lender_id in the next migration.
create type user_role as enum (
  'operator_admin',   -- GajiOne staff; sees every tenant
  'hr_admin',         -- customer: full access to their own company
  'payroll_staff',    -- customer: runs payroll, cannot change master data
  'line_manager',     -- customer: their own departments (see user_scopes)
  'employee',         -- customer: their own rows only
  'lender_officer'    -- partner lender: referrals and deductions they are party to
);

create type employment_type as enum ('permanent', 'contract', 'probation', 'daily', 'intern');

-- A period can be reopened while it is being worked on, which is why these are
-- states rather than a pair of timestamps. 'locked' is terminal: once the
-- payment file exists the numbers stop moving.
create type payroll_status as enum ('draft', 'g1_passed', 'g2_passed', 'g3_passed', 'approved', 'locked', 'cancelled');

-- Not every run is the monthly one. THR (the statutory religious holiday
-- allowance), a bonus, and a resignation settlement each land in their own run
-- in the same month, with their own tax treatment.
create type payroll_run_type as enum ('regular', 'thr', 'bonus', 'resignation', 'correction');

create type pay_component_kind as enum ('earning', 'deduction');
create type pay_calc_type as enum ('fixed', 'rate_of_base', 'formula', 'per_attendance');

create type attendance_status as enum ('present', 'absent', 'leave', 'holiday', 'off', 'anomaly');
create type approval_status as enum ('pending', 'approved', 'rejected', 'cancelled');

-- A gate rule either stops the run or annotates it. The mockup passes 12 of 14
-- rules and still moves, so severity has to be a property of the rule.
create type gate_severity as enum ('blocking', 'warning');

-- GajiOne refers; the licensed lender decides. 'referred' is as far as our own
-- state machine goes on its own — everything after it mirrors what the lender
-- told us.
create type referral_status as enum ('draft', 'referred', 'approved', 'rejected', 'cancelled', 'disbursed');

create type mandate_status as enum ('active', 'suspended', 'completed', 'cancelled');
