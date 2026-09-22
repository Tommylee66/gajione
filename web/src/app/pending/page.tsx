import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Where an authenticated but unapproved account lands.
 *
 * getSession refuses an unapproved user, and the proxy sends anyone without a
 * session to /login — which would send them straight back, forever. This page
 * is outside that loop and says what is actually happening.
 */
export default async function PendingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: row } = await supabase
    .from('users')
    .select('is_approved, is_active')
    .eq('id', user.id)
    .maybeSingle();

  // Approved since they last tried: send them on rather than leaving them
  // staring at a waiting message.
  if (row?.is_approved && row?.is_active) redirect('/');

  const { data: request } = await supabase
    .from('signup_requests')
    .select('status, reject_reason, company_name, created_at')
    .eq('auth_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const rejected = request?.status === 'rejected';

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-xl font-semibold">
          {rejected ? '가입이 거절되었습니다' : '승인 대기 중입니다'}
        </h1>
        {rejected ? (
          <>
            <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
              {request?.reject_reason ?? '사유가 기재되지 않았습니다.'}
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              문의는 GajiOne 운영팀으로 연락해 주세요.
            </p>
          </>
        ) : row?.is_active === false ? (
          <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
            이 계정은 사용이 중지되었습니다. 인사 담당자 또는 운영팀에 문의하세요.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
              {request?.company_name ? `${request.company_name} 가입 신청이 접수되었습니다. ` : ''}
              GajiOne 운영팀 검토 후 계정이 활성화됩니다.
            </p>
            {request?.created_at && (
              <p className="mt-2 text-sm text-neutral-500">
                신청 {String(request.created_at).slice(0, 10)}
              </p>
            )}
          </>
        )}
        <form action="/api/auth/signout" method="post" className="mt-6">
          <button className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
            로그아웃
          </button>
        </form>
      </div>
    </main>
  );
}
