import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { requireMe } from '@/lib/me/data';
import { BAND_LABELS, band } from '@/lib/credit/scoring';
import { REPAYMENT_LABELS, type RepaymentMethod } from '@/lib/credit/offer';
import { MyOffer } from '@/components/me-credit';

export const dynamic = 'force-dynamic';

export default async function MeCredit() {
  await requireMe();
  const supabase = await createClient();

  const [scoreRes, mandateRes, mirrorRes, offerRes, policyRes, itemRes, execRes] =
    await Promise.all([
      supabase.from('credit_scores').select('id, total_score, max_score, scored_at').order('scored_at', { ascending: false }).limit(1),
      supabase.from('deduction_mandates').select('*').eq('status', 'active'),
      supabase.from('loan_mirrors').select('*'),
      supabase.from('loan_offers').select('*').order('sent_at', { ascending: false }),
      supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
      supabase.from('payroll_items').select('net').order('created_at', { ascending: false }).limit(3),
      supabase.from('deduction_executions').select('mandate_id, period, amount').order('period', { ascending: false }),
    ]);

  const score = (scoreRes.data ?? [])[0];
  const details = score
    ? (
        await supabase
          .from('credit_score_details')
          .select('factor_name, raw_metric, points')
          .eq('credit_score_id', score.id as string)
      ).data ?? []
    : [];

  const nets = (itemRes.data ?? []).map((i) => Number(i.net));
  const monthlyNet = nets.length > 0 ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
  const maxRate = Number(policyRes.data?.max_loan_deduction_rate ?? 30);
  const mandates = mandateRes.data ?? [];
  const committed = mandates.reduce((s, m) => s + Number(m.monthly_amount), 0);
  const monthlyCap = Math.floor((monthlyNet * maxRate) / 100);
  const available = Math.max(0, monthlyCap - committed);

  const mirrorByRef = new Map((mirrorRes.data ?? []).map((m) => [m.lender_ref_no as string, m]));
  const liveOffer = (offerRes.data ?? []).find((o) => o.status === 'sent');
  // Read once, per request. force-dynamic means "now" is the moment the page
  // was asked for, which is what an expiry is measured against; the action
  // re-checks it server-side regardless.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <>
      <h1 className="text-xl font-semibold">신용·대출</h1>

      {liveOffer && (
        <MyOffer
          offer={{
            id: liveOffer.id as string,
            annual_rate: Number(liveOffer.annual_rate),
            months: Number(liveOffer.months),
            fee_percent: Number(liveOffer.fee_percent),
            fee_amount: Number(liveOffer.fee_amount),
            method_label:
              REPAYMENT_LABELS[liveOffer.repayment_method as RepaymentMethod] ??
              (liveOffer.repayment_method as string),
            monthly_amount: Number(liveOffer.first_month_amount ?? liveOffer.monthly_amount),
            total_repayment: Number(liveOffer.total_repayment),
            expires_at: liveOffer.expires_at as string,
            expired: Date.parse(liveOffer.expires_at as string) <= now,
          }}
          available={available}
        />
      )}

      {/* --- 점수 ---------------------------------------------------------- */}
      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        {score ? (
          <>
            <p className="text-xs text-neutral-500">신용점수</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {score.total_score}
              <span className="text-base font-normal text-neutral-500"> / {score.max_score}</span>
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {BAND_LABELS[band(Number(score.total_score))]} · 산출{' '}
              {String(score.scored_at).slice(0, 10)}
            </p>
            {details.length > 0 && (
              <>
                {/* The breakdown is the point. A score somebody is refused on
                    that they cannot see the working of is not a score, it is a
                    verdict. */}
                <p className="mt-3 text-sm font-medium">왜 이 점수인가요?</p>
                <ul className="mt-2 space-y-1 text-sm">
                  <li className="flex justify-between">
                    <span className="text-neutral-500">기본점수</span>
                    <span className="tabular-nums">300</span>
                  </li>
                  {details.map((d, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3">
                      <span>
                        {d.factor_name}
                        <span className="ml-1 block text-xs text-neutral-500">{d.raw_metric}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">+{d.points}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-neutral-500">
            아직 신용점수가 산출되지 않았습니다. 급여 차수가 마감되면 산출됩니다.
          </p>
        )}
      </section>

      {/* --- 한도 ---------------------------------------------------------- */}
      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">이용 가능 한도 (월 상환 기준)</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{formatRupiah(available)}</p>
        <p className="mt-1 text-sm text-neutral-500">
          월 공제 상한 {formatRupiah(monthlyCap)} ({maxRate}%) 중 {formatRupiah(committed)} 사용
          중입니다.
        </p>
        {monthlyNet === 0 && (
          <p className="mt-2 text-sm text-neutral-500">
            실수령 이력이 없어 한도를 계산할 수 없습니다.
          </p>
        )}
      </section>

      {/* --- 진행 중인 대출 -------------------------------------------------- */}
      <section className="mt-4">
        <h2 className="text-sm font-semibold">진행 중인 대출</h2>
        {mandates.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">진행 중인 대출이 없습니다.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {mandates.map((m) => {
              const mirror = m.lender_ref_no ? mirrorByRef.get(m.lender_ref_no as string) : undefined;
              const paid = (execRes.data ?? []).filter((e) => e.mandate_id === m.id).length;
              return (
                <li
                  key={m.id as string}
                  className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                >
                  <p className="font-medium">
                    월 {formatRupiah(m.monthly_amount)} · {paid}/{m.total_installments}회차
                  </p>
                  <p className="mt-1 text-neutral-500">
                    {/* The lender's figure, labelled as theirs. */}
                    잔액{' '}
                    {mirror?.balance === undefined || mirror?.balance === null
                      ? '금융기관 원장 미동기화'
                      : formatRupiah(Number(mirror.balance))}
                    {m.lender_ref_no && ` · ${m.lender_ref_no}`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
