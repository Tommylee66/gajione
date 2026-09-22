import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { loadProfile, requireMe } from '@/lib/me/data';

export const dynamic = 'force-dynamic';

export default async function MeHome() {
  const session = await requireMe();
  const profile = await loadProfile();
  const supabase = await createClient();

  const [runRes, itemRes, daysRes, slipRes, offerRes] = await Promise.all([
    supabase
      .from('payroll_runs')
      .select('id, period, pay_date, status, cutoff_start, cutoff_end')
      .order('period', { ascending: false })
      .limit(2),
    supabase
      .from('payroll_items')
      .select('run_id, gross, deduction_total, net, work_days, ot_minutes')
      .order('created_at', { ascending: false })
      .limit(2),
    supabase
      .from('attendance_days')
      .select('work_date, status, ot_minutes, is_confirmed')
      .order('work_date', { ascending: false })
      .limit(40),
    supabase.from('payslips').select('payroll_item_id, opened_at, channel').order('created_at', { ascending: false }),
    supabase.from('loan_offers').select('id, status, expires_at').eq('status', 'sent'),
  ]);

  const runs = runRes.data ?? [];
  const current = runs[0];
  const item = (itemRes.data ?? []).find((i) => i.run_id === current?.id) ?? null;
  const days = daysRes.data ?? [];
  const unopened = (slipRes.data ?? []).filter((s) => !s.opened_at);
  const pendingOffers = offerRes.data ?? [];

  const inCutoff = current
    ? days.filter(
        (d) =>
          (d.work_date as string) >= (current.cutoff_start as string) &&
          (d.work_date as string) <= (current.cutoff_end as string)
      )
    : [];
  const workedDays = inCutoff.filter((d) => d.status === 'present' || d.status === 'anomaly').length;
  const otMinutes = inCutoff.reduce((s, d) => s + Number(d.ot_minutes ?? 0), 0);
  const confirmed = inCutoff.filter((d) => d.is_confirmed).length;

  const dDay = current
    ? Math.round(
        (Date.parse(`${current.pay_date}T00:00:00Z`) -
          Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) /
          86_400_000
      )
    : null;

  return (
    <>
      <header>
        <p className="text-sm text-neutral-500">Selamat pagi</p>
        <h1 className="mt-0.5 text-xl font-semibold">{profile?.full_name ?? session.full_name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {profile?.department ?? '부서 미배정'} · {profile?.position ?? '직급 미배정'}
        </p>
      </header>

      {(unopened.length > 0 || pendingOffers.length > 0) && (
        <section className="mt-4 space-y-2">
          {unopened.length > 0 && (
            <Link
              href="/me/payslip"
              className="block rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950"
            >
              읽지 않은 급여명세서가 {unopened.length}건 있습니다 →
            </Link>
          )}
          {pendingOffers.length > 0 && (
            <Link
              href="/me/credit"
              className="block rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950"
            >
              대출 오퍼가 도착했습니다. 응답해 주세요 →
            </Link>
          )}
        </section>
      )}

      {current && (
        <section className="mt-5 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500">
            {current.period} · 지급 {current.pay_date}
            {dDay !== null && dDay >= 0 && ` (D-${dDay})`}
          </p>
          {item ? (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{formatRupiah(item.net)}</p>
              <p className="mt-1 text-sm text-neutral-500">
                {current.status === 'locked' ? '확정' : '계산 결과 · 아직 확정 전'}
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <Row label="지급총액" value={formatRupiah(item.gross)} />
                <Row label="공제" value={`−${formatRupiah(item.deduction_total)}`} />
                <Row label="근무일" value={`${item.work_days}일`} />
                <Row
                  label="초과근무"
                  value={
                    Number(item.ot_minutes) > 0
                      ? `${Math.floor(Number(item.ot_minutes) / 60)}시간 ${Number(item.ot_minutes) % 60}분`
                      : '없음'
                  }
                />
              </dl>
            </>
          ) : (
            <>
              {/* Not a projection. Computing one from an open period would put a
                  figure in front of somebody that the payroll run has not yet
                  agreed with, and they would plan around it. */}
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                이번 차수는 아직 계산되지 않았습니다. 지금까지 확정된 근태는 아래와 같습니다.
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <Row label="근무일" value={`${workedDays}일`} />
                <Row
                  label="초과근무"
                  value={otMinutes > 0 ? `${Math.floor(otMinutes / 60)}시간 ${otMinutes % 60}분` : '없음'}
                />
                <Row label="근태 확정" value={`${confirmed} / ${inCutoff.length}일`} />
              </dl>
            </>
          )}
        </section>
      )}

      {!current && (
        <p className="mt-5 text-sm text-neutral-500">아직 급여 차수가 없습니다.</p>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
