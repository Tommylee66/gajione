-- Part 21: let a partner see the consent that lets them see anything.
--
-- The score policy from part 9 reads
--   employee_id in (select employee_id from data_sharing_consents
--                    where lender_id = current_lender_id() ...)
-- and that subquery runs under the caller's own row-level security. The lender
-- had no policy on data_sharing_consents, so the subquery was always empty and
-- the score policy could never match — a rule that looked like access and
-- granted none.
--
-- Found by probing every table as a partner account rather than by reading the
-- policy, which is the only way this kind of dead grant shows up.
--
-- Fixed by granting what the rule already assumed: a partner reads the
-- consents naming them, and nobody else's. That is also the record of their
-- own lawful basis for holding the profile, which they should be able to
-- produce without asking the employer for it.
create policy "lender reads own consents" on data_sharing_consents for select to authenticated
  using (lender_id = current_lender_id());
