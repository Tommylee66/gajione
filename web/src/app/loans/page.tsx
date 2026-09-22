import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { formatRupiah } from '@/lib/format';
import { assess, type Assessment } from '@/lib/credit/scoring';
import {
  LoanPanel,
  type MandateView,
  type ReferralView,
  type ScoreDetailView,
} from '@/components/loan-panel';

export const dynamic = 'force-dynamic';

const VIEW_ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];
const ACT_ROLES = ['hr_admin', 'operator_admin'];

export default async function LoansPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!VIEW_ROLES.includes(session.role)) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">대출·신용</h1>
        <p className="mt-3 text-sm text-neutral-500">이 화면을 볼 권한이 없습니다.</p>
      </main>
    );
  }

  const supabase = await createClient();

  const [
    referralRes,
    mandateRes,
    lenderRes,
    empRes,
    deptRes,
    scoreRes,
    consentRes,
    mirrorRes,
    policyRes,
    itemRes,
    runRes,
    execRes,
  ] = await Promise.all([
    supabase.from('loan_referrals').select('*').order('created_at', { ascending: false }),
    supabase.from('deduction_mandates').select('*').order('created_at', { ascending: false }),
    supabase.from('lender_partners').select('id, name, ojk_license_no, status'),
    supabase.from('employees').select('id, employee_no, full_name, department_id'),
    supabase.from('departments').select('id, name'),
    supabase.from('credit_scores').select('*').order('scored_at', { ascending: false }),
    supabase.from('data_sharing_consents').select('*').is('revoked_at', null),
    supabase.from('loan_mirrors').select('*'),
    supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
    supabase.from('payroll_items').select('employee_id, net, created_at').order('created_at', { ascending: false }),
    supabase.from('payroll_runs').select('id, period, status').order('period', { ascending: false }),
    supabase.from('deduction_executions').select('mandate_id, period, amount, status'),
  ]);

  const employees = new Map(
    (empRes.data ?? []).map((e) => [
      e.id as string,
      {
        no: e.employee_no as string,
        name: e.full_name as string,
        department_id: (e.department_id as string | null) ?? null,
      },
    ])
  );
  const deptNames = new Map((deptRes.data ?? []).map((d) => [d.id as string, d.name as string]));
  const lenderNames = new Map((lenderRes.data ?? []).map((l) => [l.id as string, l.name as string]));
  const maxRatePercent = Number(policyRes.data?.max_loan_deduction_rate ?? 30);

  // Latest score per employee. Older rows are kept — a decision's basis must
  // not change when the score is recomputed — but only the newest is current.
  const latestScore = new Map<string, { id: string; total_score: number; scored_at: string }>();
  for (const s of scoreRes.data ?? []) {
    const key = s.employee_id as string;
    if (!latestScore.has(key)) {
      latestScore.set(key, {
        id: s.id as string,
        total_score: Number(s.total_score),
        scored_at: s.scored_at as string,
      });
    }
  }

  const { data: detailRows } = await supabase
    .from('credit_score_details')
    .select('credit_score_id, factor_name, weight, raw_metric, normalized, points')
    .in(
      'credit_score_id',
      latestScore.size > 0 ? [...latestScore.values()].map((v) => v.id) : ['']
    );
  const detailsByScore = new Map<string, ScoreDetailView[]>();
  for (const d of detailRows ?? []) {
    const key = d.credit_score_id as string;
    const list = detailsByScore.get(key) ?? [];
    list.push({
      factor_name: d.factor_name as string,
      weight: Number(d.weight),
      raw_metric: (d.raw_metric as string) ?? '',
      normalized: Number(d.normalized),
      points: Number(d.points),
    });
    detailsByScore.set(key, list);
  }

  // Average of the three most recent payslips, which is what the ceiling and
  // the instalment cap are both measured against.
  const netsByEmployee = new Map<string, number[]>();
  for (const i of itemRes.data ?? []) {
    const key = i.employee_id as string;
    const list = netsByEmployee.get(key) ?? [];
    if (list.length < 3) list.push(Number(i.net));
    netsByEmployee.set(key, list);
  }
  const monthlyNetOf = (id: string) => {
    const nets = netsByEmployee.get(id) ?? [];
    return nets.length > 0 ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
  };

  const activeMandates = (mandateRes.data ?? []).filter((m) => m.status === 'active');
  const committedByEmployee = new Map<string, number>();
  for (const m of activeMandates) {
    const key = m.employee_id as string;
    committedByEmployee.set(key, (committedByEmployee.get(key) ?? 0) + Number(m.monthly_amount));
  }

  const consentByPair = new Map<string, { id: string; scope: string }>();
  for (const c of consentRes.data ?? []) {
    consentByPair.set(`${c.employee_id}|${c.lender_id}`, {
      id: c.id as string,
      scope: c.scope as string,
    });
  }

  const mandateByReferral = new Set(
    (mandateRes.data ?? []).map((m) => m.referral_id as string).filter(Boolean)
  );

  const referrals: ReferralView[] = (referralRes.data ?? []).map((r) => {
    const employeeId = r.employee_id as string;
    const emp = employees.get(employeeId);
    const score = latestScore.get(employeeId);
    const consent = consentByPair.get(`${employeeId}|${r.lender_id}`);
    const assessment: Assessment = assess({
      score: score?.total_score ?? 0,
      amountRequested: Number(r.amount_requested),
      months: Number(r.months ?? 1),
      limitInput: {
        monthlyNet: monthlyNetOf(employeeId),
        existingMonthly: committedByEmployee.get(employeeId) ?? 0,
        maxRatePercent,
      },
      hasConsent: Boolean(consent),
    });
    return {
      id: r.id as string,
      employee_id: employeeId,
      lender_id: r.lender_id as string,
      employee_no: emp?.no ?? '—',
      employee_name: emp?.name ?? '(알 수 없음)',
      department: emp?.department_id ? (deptNames.get(emp.department_id) ?? null) : null,
      product_label: (r.product_label as string | null) ?? null,
      amount_requested: Number(r.amount_requested),
      months: Number(r.months ?? 1),
      status: r.status as string,
      lender_decision: (r.lender_decision as string | null) ?? null,
      lender_ref_no: (r.lender_ref_no as string | null) ?? null,
      decline_reason: (r.decline_reason as string | null) ?? null,
      lender_name: lenderNames.get(r.lender_id as string) ?? '(미등록 금융기관)',
      score: score?.total_score ?? null,
      scoredAt: score?.scored_at ?? null,
      details: score ? (detailsByScore.get(score.id) ?? []) : [],
      consentScope: consent?.scope ?? null,
      consentId: consent?.id ?? null,
      assessment,
      hasMandate: mandateByReferral.has(r.id as string),
    };
  });

  const mirrorByRef = new Map(
    (mirrorRes.data ?? []).map((m) => [m.lender_ref_no as string, m])
  );
  const openRun = (runRes.data ?? []).find((r) => r.status !== 'locked' && r.status !== 'cancelled');
  const execByMandate = new Map<string, number>();
  for (const e of execRes.data ?? []) {
    if (openRun && e.period === (openRun.period as string)) {
      execByMandate.set(e.mandate_id as string, Number(e.amount));
    }
  }

  const mandates: MandateView[] = (mandateRes.data ?? []).map((m) => {
    const emp = employees.get(m.employee_id as string);
    const mirror = m.lender_ref_no ? mirrorByRef.get(m.lender_ref_no as string) : undefined;
    const paidFromExec = (execRes.data ?? []).filter(
      (e) => e.mandate_id === m.id && e.status !== 'skipped'
    ).length;
    return {
      id: m.id as string,
      employee_no: emp?.no ?? '—',
      employee_name: emp?.name ?? '(알 수 없음)',
      lender_name: lenderNames.get(m.lender_id as string) ?? '(미등록 금융기관)',
      monthly_amount: Number(m.monthly_amount),
      total_installments: Number(m.total_installments),
      // The lender's own count wins where we have it; ours is what we can
      // prove from the payslips we actually deducted from.
      paid_installments: Number(mirror?.paid_installments ?? paidFromExec),
      balance: mirror?.balance !== undefined && mirror?.balance !== null ? Number(mirror.balance) : null,
      mirror_synced_at: (mirror?.synced_at as string | undefined) ?? null,
      is_overdue: Boolean(mirror?.is_overdue),
      status: m.status as string,
      start_period: m.start_period as string,
      thisPeriodAmount: execByMandate.get(m.id as string) ?? null,
    };
  });

  const activeCount = activeMandates.length;
  const balanceTotal = mandates.reduce((s, m) => s + (m.balance ?? 0), 0);
  const monthlyTotal = activeMandates.reduce((s, m) => s + Number(m.monthly_amount), 0);
  const overdue = mandates.filter((m) => m.is_overdue).length;
  const scores = [...latestScore.values()].map((s) => s.total_score);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : null;
  const unsynced = mandates.filter((m) => m.balance === null).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">대출·신용</h1>
          <p className="mt-1 text-sm text-neutral-500">
            심사대기 {referrals.filter((r) => r.status === 'draft').length}건 · 전달됨{' '}
            {referrals.filter((r) => r.status === 'referred').length}건
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="활성 공제" value={`${activeCount}건`} />
        <Stat
          label="대출잔액"
          value={balanceTotal > 0 ? formatRupiah(balanceTotal) : '—'}
          sub={unsynced > 0 ? `미동기화 ${unsynced}건` : undefined}
        />
        <Stat label="이번달 공제" value={formatRupiah(monthlyTotal)} />
        <Stat label="연체" value={`${overdue}건`} />
        <Stat
          label="평균 신용점수"
          value={avgScore === null ? '—' : `${avgScore}/850`}
          sub={avgScore === null ? '미산출' : `${scores.length}명`}
        />
      </section>

      <LoanPanel
        referrals={referrals}
        mandates={mandates}
        lenders={(lenderRes.data ?? []) as { id: string; name: string; ojk_license_no: string | null; status: string }[]}
        lockedRuns={(runRes.data ?? [])
          .filter((r) => r.status === 'locked')
          .map((r) => ({ id: r.id as string, period: r.period as string }))}
        canAct={ACT_ROLES.includes(session.role)}
      />

      {/* --- 모델 설명 ------------------------------------------------------- */}
      <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">신용점수 모델</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          기본 300점에 4개 항목을 가중합산해 850점 만점으로 산출합니다. 700점 이상 자동심사 통과,
          600~699점 수동심사, 600점 미만은 전달하지 않습니다. 점수와 무관하게 정보제공 동의가
          없거나 공제 여력을 넘으면 전달되지 않습니다.
        </p>
        {/* The curve is now a setting, not a hardcoded guess — but somebody
            still has to decide it, and the screen says where. */}
        <p className="mt-2 text-sm text-neutral-500">
          항목별 환산 곡선은 정책·요율 화면의 &lsquo;신용점수 산출 곡선&rsquo;에서 설정합니다.
          현재 값은 초기값이므로, 실제 거절 근거로 쓰기 전에 신용리스크 기준을 확정하세요.
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}
