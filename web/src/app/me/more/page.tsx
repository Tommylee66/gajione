import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { loadProfile, requireMe } from '@/lib/me/data';
import { employmentLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MeMore() {
  const session = await requireMe();
  const profile = await loadProfile();
  const supabase = await createClient();

  // Their own bank account, by last four only. The full number is encrypted
  // and is not decrypted for this screen: confirming which account their pay
  // lands in does not require showing it back to them.
  const { data: account } = await supabase
    .from('employee_bank_accounts')
    .select('bank_name, account_number_last4, holder_name')
    .eq('is_primary', true)
    .maybeSingle();

  return (
    <>
      <h1 className="text-xl font-semibold">더보기</h1>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-lg font-semibold">{profile?.full_name ?? session.full_name}</p>
        <p className="mt-1 text-sm text-neutral-500">
          {profile?.employee_no} · {profile?.position ?? '직급 미배정'} ·{' '}
          {profile?.department ?? '부서 미배정'}
        </p>
        <dl className="mt-3 space-y-1 text-sm">
          <Row label="소속" value={profile?.employer ?? '—'} />
          <Row label="고용형태" value={employmentLabel(profile?.employment_type ?? '')} />
          <Row label="입사일" value={profile?.join_date ?? '—'} />
          <Row label="기본급" value={profile ? formatRupiah(profile.base_salary) : '—'} />
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">급여 수령 계좌</h2>
        {account ? (
          <p className="mt-2 text-sm">
            {account.bank_name} ••••{account.account_number_last4 ?? '????'}
            {account.holder_name && ` · ${account.holder_name}`}
          </p>
        ) : (
          <p className="mt-2 text-sm text-red-600">
            등록된 계좌가 없습니다. 계좌가 없으면 급여가 이체되지 않습니다. 인사팀에 등록을
            요청하세요.
          </p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          계좌번호는 암호화되어 저장되며 끝 4자리만 표시합니다. 변경은 인사팀을 통해 신청하세요.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">계정</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{session.email}</p>
        <form action="/api/auth/signout" method="post" className="mt-3">
          <button className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
            로그아웃
          </button>
        </form>
      </section>

      {/* Named rather than left as empty screens. A tab that opens onto
          nothing reads as broken; a line that says what is not built yet
          reads as honest. */}
      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">아직 없는 기능</h2>
        <ul className="mt-2 space-y-1 text-sm text-neutral-500">
          <li>· 공지사항 — 공지를 작성하는 화면이 아직 없습니다</li>
          <li>· 동료 찾기 — 직원 간 조회 범위를 정한 뒤 열 예정입니다</li>
          <li>· 알림 — 발송 연동(WhatsApp·이메일) 이후 동작합니다</li>
          <li>· 정보 변경 요청 — 인사팀에 직접 문의해 주세요</li>
        </ul>
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
