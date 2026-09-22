-- Part 22: what a worker may see and do about their own record.
--
-- Part 9 gave an employee read access to their own payslip, attendance, leave
-- and score. It did not give them the payslip delivery record, their own loan
-- offer, or any way to act — which meant two things the rest of the system
-- already assumed had to be done by somebody else on their behalf:
-- payslips.opened_at was never set by anyone who opened a payslip, and a loan
-- offer was accepted by HR relaying what the worker said.
--
-- Everything below is scoped to current_employee_id(). None of it lets a
-- worker see a colleague's row.

-- --- The payslip delivery record --------------------------------------------
-- Read, so the app can tell them one is waiting. Updated only to mark it
-- opened — by the person opening it, which is the only signature that figure
-- ever had any meaning from.
create policy "employee reads own payslip delivery" on payslips for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee opens own payslip" on payslips for update to authenticated
  using (employee_id = current_employee_id())
  with check (employee_id = current_employee_id());

-- --- Leave ------------------------------------------------------------------
-- A request is the worker's to make. Approval is not: the update policy from
-- part 9 belongs to their manager, and nothing here grants one.
create policy "employee requests own leave" on leaves for insert to authenticated
  with check (employee_id = current_employee_id());
create policy "employee reads own leave balance" on leave_balances for select to authenticated
  using (employee_id = current_employee_id());

-- --- Shifts and raw punches -------------------------------------------------
-- The roster they are on, and the punches attributed to them. "I clocked in at
-- 07:02" is a claim they should be able to check rather than ask about.
create policy "employee reads own schedule" on shift_schedules for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own punches" on attendance_raw for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads shifts" on shifts for select to authenticated
  using (company_id in (select company_id from employees where id = current_employee_id()));

-- --- Credit and loans -------------------------------------------------------
create policy "employee reads own score details" on credit_score_details for select to authenticated
  using (credit_score_id in (
    select id from credit_scores where employee_id = current_employee_id()
  ));
create policy "employee reads own referrals" on loan_referrals for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own mandates" on deduction_mandates for select to authenticated
  using (employee_id = current_employee_id());
create policy "employee reads own deductions" on deduction_executions for select to authenticated
  using (mandate_id in (
    select id from deduction_mandates where employee_id = current_employee_id()
  ));

-- The offer, and the answer to it. This is the whole point of the app for the
-- lending flow: an offer accepted by HR on somebody's behalf is a deduction
-- nobody can show the borrower agreed to.
create policy "employee reads own offers" on loan_offers for select to authenticated
  using (referral_id in (
    select id from loan_referrals where employee_id = current_employee_id()
  ));
create policy "employee responds to own offers" on loan_offers for update to authenticated
  using (referral_id in (
    select id from loan_referrals where employee_id = current_employee_id()
  ))
  with check (referral_id in (
    select id from loan_referrals where employee_id = current_employee_id()
  ));

-- --- Reference data the app has to render ----------------------------------
-- Their own department and grade, by name. Without these the app shows a uuid
-- where the mockup shows "조립1라인".
create policy "employee reads own department" on departments for select to authenticated
  using (id in (select department_id from employees where id = current_employee_id()));
create policy "employee reads own position" on positions for select to authenticated
  using (id in (select position_id from employees where id = current_employee_id()));
create policy "employee reads own employer" on companies for select to authenticated
  using (id in (select company_id from employees where id = current_employee_id()));

-- --- Who relayed an answer --------------------------------------------------
-- responded_by records whether the worker answered or somebody answered for
-- them. Nullable, because offers predating the app have no answer of either
-- kind, and defaulting it to anyone would be a claim about who spoke.
alter table loan_offers add column responded_by uuid;
comment on column loan_offers.responded_by is
  'The user who recorded the response: the employee themselves, or HR relaying.';
