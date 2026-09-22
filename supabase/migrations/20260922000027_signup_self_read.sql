-- Part 27: let an applicant see their own application.
--
-- signup_requests was operator-only, which is right for everybody else's. But
-- the waiting screen has to tell the applicant whether they are still pending
-- or were turned down and why, and it had no way to read either — so it would
-- have shown the same message in both cases.
create policy "applicant reads own request" on signup_requests for select to authenticated
  using (auth_user_id = auth.uid());
