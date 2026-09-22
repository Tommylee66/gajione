-- Part 26: signing up, and the terms that are agreed to when you do.
--
-- A payroll system is not open registration. Someone signing up is asking to
-- become a customer, and the answer is an operator's to give — so a signup
-- produces a request, not a company. Nothing about the tenant exists until
-- somebody approves it, which keeps the customer list a list of customers.

-- ---------------------------------------------------------------------------
-- The documents
-- ---------------------------------------------------------------------------
-- Versioned, because "they agreed to the terms" is worthless without saying
-- which terms. A revision creates a new row; the old one stays so an
-- acceptance recorded last year still points at what was actually shown.
create table terms_documents (
  id uuid primary key default gen_random_uuid(),
  code varchar(40) not null,                     -- 'tos' / 'privacy' / 'dpa' / 'efin'
  version varchar(20) not null,
  title varchar(255) not null,
  body text not null,
  required boolean not null default true,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  unique (code, version)
);
create index terms_documents_code_idx on terms_documents (code, effective_from desc);

alter table terms_documents enable row level security;
-- Readable by anyone, including before they have an account: a person cannot
-- agree to terms they have to sign in to read.
create policy "anyone reads terms" on terms_documents for select to anon, authenticated
  using (effective_to is null);
create policy "operator writes terms" on terms_documents for all to authenticated
  using (is_operator()) with check (is_operator());

-- ---------------------------------------------------------------------------
-- What was agreed, by whom, to which version
-- ---------------------------------------------------------------------------
create table terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  signup_request_id uuid,
  document_code varchar(40) not null,
  document_version varchar(20) not null,
  accepted boolean not null,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index terms_acceptances_user_idx on terms_acceptances (user_id);
create index terms_acceptances_request_idx on terms_acceptances (signup_request_id);

alter table terms_acceptances enable row level security;
create policy "reads own acceptances" on terms_acceptances for select to authenticated
  using (is_operator() or user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- The request
-- ---------------------------------------------------------------------------
-- No password column. The credential lives in Supabase auth from the moment
-- the account is created; putting one here would mean a plaintext or
-- separately-hashed copy of something the auth system already holds properly.
create table signup_requests (
  id uuid primary key default gen_random_uuid(),
  company_name varchar(255) not null,
  npwp varchar(30),
  industry varchar(100),
  headcount_band varchar(40),
  region varchar(100),

  contact_name varchar(255) not null,
  contact_title varchar(100),
  email varchar(255) not null,
  phone varchar(40),

  marketing_opt_in boolean not null default false,
  -- The auth user created at signup. They cannot sign in until approval sets
  -- is_approved on their users row.
  auth_user_id uuid,

  status varchar(20) not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  reject_reason text,
  company_id uuid,                               -- set when approved

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index signup_requests_status_idx on signup_requests (status, created_at desc);
create unique index signup_requests_email_pending_idx
  on signup_requests (lower(email)) where status = 'pending';

alter table signup_requests enable row level security;
-- Only the operator. A request holds a prospect's contact details and belongs
-- to nobody's tenant — there is no tenant yet.
create policy "operator manages signups" on signup_requests for all to authenticated
  using (is_operator()) with check (is_operator());

-- ---------------------------------------------------------------------------
-- Seed the documents
-- ---------------------------------------------------------------------------
-- The mockup's text, which is placeholder and says so. Real terms are a legal
-- deliverable; what this establishes is that they are versioned, shown before
-- agreement, and recorded against the version shown.
insert into terms_documents (code, version, title, body, required, effective_from) values
  ('tos', '2026.1', 'GajiOne 이용약관', E'제1조(목적) 본 약관은 GajiOne 서비스의 이용 조건 및 절차, 회사와 이용자의 권리·의무를 규정합니다.\n\n제2조(용어의 정의) "이용자"란 본 약관에 따라 서비스를 이용하는 고객사 및 그 소속 담당자를 말합니다.\n\n제3조(약관의 효력 및 변경) 회사는 관계 법령을 위반하지 않는 범위에서 약관을 개정할 수 있으며, 개정 시 사전 공지합니다.\n\n제4조(서비스 중단) 회사는 시스템 점검, 장애 등 부득이한 사유가 있는 경우 서비스 제공을 일시 중단할 수 있습니다.\n\n※ 이 문서는 초안입니다. 서비스 개시 전 법률 검토를 거친 정식 약관으로 대체되어야 합니다.', true, '2026-01-01'),
  ('privacy', '2026.1', '개인정보처리방침', E'제1조(수집 항목) 회사는 서비스 제공을 위해 담당자 성명, 연락처, 이메일 등 최소한의 정보를 수집합니다.\n\n제2조(이용 목적) 수집된 정보는 계정 인증, 고객 지원, 서비스 안내 목적으로만 사용됩니다.\n\n제3조(보관 기간) 회원 탈퇴 시 관련 법령이 정한 기간을 제외하고 지체 없이 파기합니다.\n\n제4조(정보주체의 권리) 이용자는 UU PDP 27/2022에 따라 열람·정정·삭제·처리정지를 요구할 수 있습니다.\n\n※ 이 문서는 초안입니다. 서비스 개시 전 법률 검토를 거친 정식 방침으로 대체되어야 합니다.', true, '2026-01-01'),
  ('marketing', '2026.1', '마케팅 정보 수신 동의', E'제1조(수신 정보) 신규 기능, 프로모션, 세무·급여 규정 변경 안내 등을 이메일 및 SMS로 발송할 수 있습니다.\n\n제2조(수신 동의 철회) 이용자는 언제든지 설정 메뉴 또는 수신 거부 링크를 통해 동의를 철회할 수 있습니다.', false, '2026-01-01'),
  ('dpa', '2026.1', '데이터 처리 위탁 계약 (DPA)', E'제1조(위탁 범위) 고객사는 급여·근태 처리를 위해 소속 직원의 개인정보 처리를 회사에 위탁합니다.\n\n제2조(수탁자의 의무) 회사는 위탁받은 개인정보를 위탁 목적 외로 이용하지 않으며, 재위탁 시 고객사의 사전 동의를 받습니다.\n\n제3조(보안 조치) 회사는 접근통제, 암호화, 접속기록 보관 등 UU PDP가 요구하는 기술적·관리적 조치를 시행합니다.\n\n※ 이 문서는 초안입니다. 서비스 개시 전 법률 검토를 거친 정식 계약서로 대체되어야 합니다.', true, '2026-01-01');
