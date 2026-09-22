import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { formatRupiah } from '@/lib/format';
import {
  ApplicationQueue,
  MonitorTable,
  type ApplicationView,
  type MonitorRow,
  type OfferView,
  type ProfileSnapshot,
} from '@/components/partner-panel';

export const dynamic = 'force-dynamic';

/**
 * The partner portal.
 *
 * Everything on this page comes from rows RLS already scopes to the signed-in
 * lender — referrals they were sent, offers they wrote, mandates they are
 * party to. There is no company filter in the queries because there is no
 * need for one: a partner cannot read another partner's rows, and cannot read
 * an employee record at all.
 */
export default async function PartnerPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role !== 'lender_officer') {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">금융기관 파트너 포털</h1>
        <p className="mt-3 text-sm text-neutral-500">
          금융기관 담당자 계정으로만 접근할 수 있습니다. 사내 화면은{' '}
          <Link href="/" className="text-blue-600 underline">
            홈
          </Link>
          에서 확인하세요.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const [partnerRes, refRes, offerRes, mandateRes, mirrorRes, execRes] = await Promise.all([
    supabase.from('lender_partners').select('name, ojk_license_no, status').maybeSingle(),
    supabase.from('loan_referrals').select('*').order('created_at', { ascending: false }),
    supabase.from('loan_offers').select('*').order('sent_at', { ascending: false }),
    supabase.from('deduction_mandates').select('*'),
    supabase.from('loan_mirrors').select('*'),
    supabase
      .from('deduction_executions')
      .select('mandate_id, period, amount, status, shortfall_reason')
      .order('period', { ascending: false }),
  ]);

  const offersByReferral = new Map<string, OfferView[]>();
  for (const o of offerRes.data ?? []) {
    const key = o.referral_id as string;
    const list = offersByReferral.get(key) ?? [];
    list.push({
      id: o.id as string,
      annual_rate: Number(o.annual_rate),
      months: Number(o.months),
      fee_percent: Number(o.fee_percent),
      repayment_method: o.repayment_method as string,
      monthly_amount: Number(o.monthly_amount),
      first_month_amount: o.first_month_amount === null ? null : Number(o.first_month_amount),
      fee_amount: Number(o.fee_amount),
      total_repayment: Number(o.total_repayment),
      expires_at: o.expires_at as string,
      sent_at: o.sent_at as string,
      responded_at: (o.responded_at as string | null) ?? null,
      decline_reason: (o.decline_reason as string | null) ?? null,
      status: o.status as string,
      lender_ref_no: (o.lender_ref_no as string | null) ?? null,
      disbursed_at: (o.disbursed_at as string | null) ?? null,
    });
    offersByReferral.set(key, list);
  }

  const mandateByReferral = new Set(
    (mandateRes.data ?? []).map((m) => m.referral_id as string).filter(Boolean)
  );

  const applications: ApplicationView[] = (refRes.data ?? []).map((r) => ({
    id: r.id as string,
    // A readable handle for a row the partner has no other name for.
    ref_no: `LN-${String(r.created_at).slice(0, 10).replace(/-/g, '')}-${String(r.id).slice(0, 4).toUpperCase()}`,
    amount_requested: Number(r.amount_requested),
    months: Number(r.months ?? 0),
    product_label: (r.product_label as string | null) ?? null,
    status: r.status as string,
    created_at: r.created_at as string,
    score: r.score_snapshot === null ? null : Number(r.score_snapshot),
    profile: ((r.profile_snapshot as ProfileSnapshot | null) ?? {}) as ProfileSnapshot,
    offers: offersByReferral.get(r.id as string) ?? [],
    hasMandate: mandateByReferral.has(r.id as string),
  }));

  // Awaiting the partner: referred, no live offer.
  const pending = applications.filter(
    (a) => a.status === 'referred' && !a.offers.some((o) => o.status === 'sent' || o.status === 'accepted')
  );
  const awaitingEmployee = applications.filter((a) => a.offers.some((o) => o.status === 'sent'));
  const awaitingDisbursement = applications.filter((a) =>
    a.offers.some((o) => o.status === 'accepted')
  );

  const mirrorByRef = new Map((mirrorRes.data ?? []).map((m) => [m.lender_ref_no as string, m]));
  const latestPeriod = (execRes.data ?? [])[0]?.period as string | undefined;
  const execByMandate = new Map<string, { amount: number; status: string; reason: string | null }>();
  for (const e of execRes.data ?? []) {
    if (e.period === latestPeriod && !execByMandate.has(e.mandate_id as string)) {
      execByMandate.set(e.mandate_id as string, {
        amount: Number(e.amount),
        status: e.status as string,
        reason: (e.shortfall_reason as string | null) ?? null,
      });
    }
  }

  const monitor: MonitorRow[] = (mandateRes.data ?? [])
    .filter((m) => m.status !== 'cancelled')
    .map((m) => {
      const mirror = m.lender_ref_no ? mirrorByRef.get(m.lender_ref_no as string) : undefined;
      const exec = execByMandate.get(m.id as string);
      return {
        // Known from the point a loan exists — there is a credit agreement by
        // then. Nothing before disbursement carries a name.
        borrower: (m.borrower_name as string | null) ?? '(성명 미기재)',
        employer: applications.find((a) => a.id === m.referral_id)?.profile.employer ?? '—',
        lender_ref_no: (m.lender_ref_no as string | null) ?? null,
        principal: mirror?.principal === undefined || mirror?.principal === null ? null : Number(mirror.principal),
        monthly_amount: Number(m.monthly_amount),
        paid: Number(mirror?.paid_installments ?? 0),
        total: Number(m.total_installments),
        is_overdue: Boolean(mirror?.is_overdue),
        period_status: exec
          ? exec.status === 'skipped'
            ? `${latestPeriod} 공제 유예 — ${exec.reason ?? '사유 미기재'}`
            : `${latestPeriod} 공제 확인 ${formatRupiah(exec.amount)}`
          : '이번 차수 공제 기록 없음',
      };
    });

  const outstanding = monitor.reduce((s, m) => s + (m.principal ?? 0), 0);
  const overdue = monitor.filter((m) => m.is_overdue).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">
          금융기관 파트너 포털
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{partnerRes.data?.name ?? '제휴 금융기관'}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {session.full_name} 담당자로 로그인됨 · OJK {partnerRes.data?.ojk_license_no ?? '미등록'}
        </p>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="심사 대기" value={`${pending.length}건`} />
        <Stat label="수락 대기" value={`${awaitingEmployee.length}건`} />
        <Stat label="실행 대기" value={`${awaitingDisbursement.length}건`} />
        <Stat label="실행 잔액" value={outstanding > 0 ? formatRupiah(outstanding) : '—'} />
        <Stat label="연체" value={`${overdue}건`} />
      </section>

      {/* --- 중개 구조 안내 ------------------------------------------------- */}
      <section className="mt-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">GajiOne 대출 중개 구조</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          GajiOne은 대출을 직접 실행하지 않습니다. 직원의 신청과 급여·근태 기반 신용 프로필을
          전달하고, 심사·오퍼·실행·상환 정산은 금융기관이 담당합니다.
        </p>
        {/* Not a policy statement — a description of what this portal can
            actually read. */}
        <p className="mt-2 text-sm text-neutral-500">
          개인정보 최소화: 이 포털에는 GajiOne이 산출한 신용 프로필 요약만 표시되며, 직원의
          주민등록번호·납세번호·급여명세는 전달되지 않습니다. 성명은 대출이 실행된 이후에만
          표시됩니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">대출 신청 큐</h2>
        <p className="mt-1 text-sm text-neutral-500">
          심사 대기 {pending.length}건 · 수락 대기 {awaitingEmployee.length}건 · 실행 대기{' '}
          {awaitingDisbursement.length}건
        </p>
        <ApplicationQueue items={applications} />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">상환 모니터링</h2>
        <p className="mt-1 text-sm text-neutral-500">
          진행 회차와 잔액은 귀사가 동기화한 원장 기준이며, 공제 대사는 GajiOne이 실제로 집행한
          내역입니다.
        </p>
        <MonitorTable rows={monitor} />
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
