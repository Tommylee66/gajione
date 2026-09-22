-- Part 28: which documents are agreed at signup, and which are policy.
--
-- terms_documents had one flag, `required`, and it was being asked to mean two
-- things: whether consent is mandatory, and whether it is collected on the
-- signup form. The DPA is mandatory and is not collected there — it is agreed
-- on the contract — so the signup validator demanded a consent the form never
-- showed and no signup could complete.
--
-- Found by running one. The two conditions read identically in the code and
-- only diverge against real data.
alter table terms_documents add column at_signup boolean not null default true;

comment on column terms_documents.at_signup is
  'Shown on the signup form. Mandatory documents agreed elsewhere (the DPA, on
   the contract) are required but not at_signup.';

update terms_documents set at_signup = false where code = 'dpa';
