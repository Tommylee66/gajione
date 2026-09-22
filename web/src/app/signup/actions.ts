'use server';

import { createClient as createAdminClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/**
 * Signing up.
 *
 * A payroll system is not open registration: this creates a request, not a
 * customer. Nothing about the tenant exists until an operator approves it, so
 * there is no company row to leak, no data to isolate, and nothing for a bad
 * signup to reach.
 *
 * The credential goes straight into Supabase auth and never touches our
 * tables. The users row is created unapproved, which getSession already
 * refuses — so the account exists and cannot be used.
 */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('서버 설정이 완료되지 않았습니다.');
  return createAdminClient(url, key, { auth: { persistSession: false } });
}

export interface SignupResult {
  ok: boolean;
  error?: string;
  field?: string;
}

export interface SignupInput {
  companyName: string;
  npwp: string;
  industry: string;
  headcountBand: string;
  region: string;
  contactName: string;
  contactTitle: string;
  email: string;
  phone: string;
  password: string;
  acceptances: { code: string; version: string; accepted: boolean }[];
}

/** Long enough to resist a list, without a composition rule people write on a sticky note. */
const MIN_PASSWORD = 10;

export async function submitSignupAction(input: SignupInput): Promise<SignupResult> {
  try {
    const email = input.email.trim().toLowerCase();
    if (!input.companyName.trim()) return { ok: false, field: 'companyName', error: '회사명을 입력하세요.' };
    if (!input.contactName.trim()) return { ok: false, field: 'contactName', error: '담당자 이름을 입력하세요.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, field: 'email', error: '이메일 형식이 올바르지 않습니다.' };
    }
    if (input.password.length < MIN_PASSWORD) {
      return { ok: false, field: 'password', error: `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.` };
    }

    const supabase = await createClient();
    const { data: docs } = await supabase
      .from('terms_documents')
      .select('code, version, required, title, at_signup')
      .is('effective_to', null);

    // Checked against the documents that are actually in force, not against
    // what the form sent: a client that omits a required consent, or claims a
    // version that was withdrawn, must not be able to sign anything.
    // Both conditions, because they are different questions: `required` is
    // whether consent is mandatory, `at_signup` whether this form is where it
    // is given. The DPA is the first without the second.
    const signupDocs = (docs ?? []).filter((d) => d.at_signup);
    const required = signupDocs.filter((d) => d.required);
    for (const d of required) {
      const a = input.acceptances.find((x) => x.code === d.code);
      if (!a || !a.accepted) {
        return { ok: false, field: 'terms', error: `${d.title}에 동의해야 가입할 수 있습니다.` };
      }
      if (a.version !== d.version) {
        return {
          ok: false,
          field: 'terms',
          error: '약관이 변경되었습니다. 새로고침 후 다시 확인해 주세요.',
        };
      }
    }

    const sb = admin();

    const { data: pending } = await sb
      .from('signup_requests')
      .select('id')
      .eq('status', 'pending')
      .ilike('email', email)
      .limit(1);
    if ((pending ?? []).length > 0) {
      return {
        ok: false,
        field: 'email',
        error: '이미 접수된 신청이 있습니다. 승인 결과를 기다려 주세요.',
      };
    }

    // signUp rather than admin.createUser: the admin call marks an address
    // unconfirmed without sending anything, so the confirmation link the
    // screen promises would never arrive. This sends it.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const { data: created, error: authError } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: {
        emailRedirectTo: origin ? `${origin}/pending` : undefined,
        data: { full_name: input.contactName.trim() },
      },
    });
    if (authError || !created?.user) {
      // Not echoed back verbatim: "already registered" tells anyone with the
      // form which addresses have accounts.
      return {
        ok: false,
        field: 'email',
        error: '이 이메일로는 가입할 수 없습니다. 이미 계정이 있다면 로그인 또는 비밀번호 찾기를 이용하세요.',
      };
    }

    const userId = created.user.id;

    // signUp answers an already-registered address with a look-alike user
    // rather than an error, on purpose. Finding a users row for this id means
    // the address is taken — answered the same way as any other refusal so the
    // form still cannot be used to enumerate addresses.
    const { data: existingUser } = await sb.from('users').select('id').eq('id', userId).maybeSingle();
    if (existingUser) {
      return {
        ok: false,
        field: 'email',
        error: '이 이메일로는 가입할 수 없습니다. 이미 계정이 있다면 로그인 또는 비밀번호 찾기를 이용하세요.',
      };
    }

    // Unapproved, and with no company: getSession refuses both, so the
    // account exists and reaches nothing until an operator says otherwise.
    const { error: userError } = await sb.from('users').insert({
      id: userId,
      email,
      full_name: input.contactName.trim(),
      role: 'hr_admin',
      company_id: null,
      is_active: true,
      is_approved: false,
    });
    if (userError) {
      // Rolled back, or the address is stuck: an auth user with no users row
      // can never sign in and can never sign up again.
      await sb.auth.admin.deleteUser(userId);
      throw userError;
    }

    const marketing = input.acceptances.find((a) => a.code === 'marketing');
    const { data: request, error: reqError } = await sb
      .from('signup_requests')
      .insert({
        company_name: input.companyName.trim(),
        npwp: input.npwp.trim() || null,
        industry: input.industry || null,
        headcount_band: input.headcountBand || null,
        region: input.region || null,
        contact_name: input.contactName.trim(),
        contact_title: input.contactTitle.trim() || null,
        email,
        phone: input.phone.trim() || null,
        marketing_opt_in: Boolean(marketing?.accepted),
        auth_user_id: userId,
        status: 'pending',
      })
      .select('id')
      .single();
    if (reqError) {
      await sb.from('users').delete().eq('id', userId);
      await sb.auth.admin.deleteUser(userId);
      throw reqError;
    }

    // Every document that was shown, including the ones declined. "They did
    // not opt in" is a fact worth keeping, and only the recorded decline
    // proves it was offered.
    const rows = signupDocs.map((d) => {
      const a = input.acceptances.find((x) => x.code === d.code);
      return {
        user_id: userId,
        signup_request_id: request.id as string,
        document_code: d.code as string,
        document_version: d.version as string,
        accepted: Boolean(a?.accepted),
      };
    });
    if (rows.length > 0) await sb.from('terms_acceptances').insert(rows);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '가입 신청에 실패했습니다.' };
  }
}

/**
 * Sends a password reset link.
 *
 * Always answers the same way. Telling somebody the address is unknown turns
 * this form into a way to find out which addresses have accounts.
 */
export async function requestPasswordResetAction(email: string): Promise<SignupResult> {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, field: 'email', error: '이메일 형식이 올바르지 않습니다.' };
  }
  try {
    const supabase = await createClient();
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? '';
    await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo: origin ? `${origin}/reset` : undefined,
    });
  } catch {
    // Swallowed on purpose, for the same reason.
  }
  return { ok: true };
}
