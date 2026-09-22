import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { formatRupiah } from '@/lib/format';
import {
  RUN_TYPE_LABELS,
  STATUS_LABELS,
  auditLabel,
  byDepartment,
  composition,
  dDayLabel,
  decisionQueue,
  delta,
  gateProgress,
  pipeline,
  type RunStatus,
  type RunSummary,
} from '@/lib/payroll/home';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { run: requestedRun } = await searchParams;
  const supabase = await createClient();

  const { data: runRows } = await supabase
    .from('payroll_runs')
    .select('*')
    .order('period', { ascending: false })
    .order('seq', { ascending: false });
  const runs = (runRows ?? []) as unknown as RunSummary[];

  if (runs.length === 0) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">페이롤 홈</h1>
        <p className="mt-3 text-sm text-neutral-500">
          아직 급여 차수가 없습니다.{' '}
          <Link href="/payroll" className="text-blue-600 underline">
            급여 차수에서 시작
          </Link>
          하세요.
        </p>
      </main>
    );
  }

  // The newest run that is still moving is what the month is about; if
  // everything is closed, the newest closed one is what people ask about.
  const openRun = runs.find((r) => r.status !== 'locked' && r.status !== 'cancelled');
  const run = runs.find((r) => r.id === requestedRun) ?? openRun ?? runs[0];
  // Runs of other types in the same month are shown beside it, not added to
  // it: each batch passes its own gates and produces its own transfer file.
  const sameMonth = runs.filter((r) => r.period === run.period);
  const prevRegular = runs.find(
    (r) => r.run_type === run.run_type && r.period < run.period && r.employee_count > 0
  );

  const [
    anomalyRes,
    otRes,
    gateRes,
    caseRes,
    recalcRes,
    approvalRes,
    fileRes,
    itemRes,
    deptRes,
    auditRes,
    empRes,
    acctRes,
  ] = await Promise.all([
    supabase.from('attendance_anomalies').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('ot_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('gate_results').select('passed').eq('run_id', run.id),
    supabase.from('variance_cases').select('status').eq('run_id', run.id),
    supabase.from('payroll_recalcs').select('batch_hash').eq('run_id', run.id),
    supabase.from('approvals').select('step_no, role_label, status').eq('run_id', run.id).order('step_no'),
    supabase.from('payment_files').select('id').eq('run_id', run.id).limit(1),
    supabase.from('payroll_items').select('id, department_id, net, ot_minutes').eq('run_id', run.id),
    supabase.from('departments').select('id, name'),
    supabase
      .from('audit_log')
      .select('action, created_at, details')
      .eq('target_id', run.id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('employees').select('id').eq('is_active', true),
    supabase.from('employee_bank_accounts').select('employee_id').eq('is_primary', true),
  ]);

  const gateResults = gateRes.data ?? [];
  const cases = caseRes.data ?? [];
  const recalcs = recalcRes.data ?? [];
  const approvals = approvalRes.data ?? [];
  const items = itemRes.data ?? [];
  const activeEmployees = empRes.data ?? [];
  const withAccount = new Set((acctRes.data ?? []).map((a) => a.employee_id as string));

  const ctx = {
    openAnomalies: anomalyRes.count ?? 0,
    pendingOt: otRes.count ?? 0,
    batchHash: run.batch_hash ?? null,
    taxVersion: run.tax_table_version ?? null,
    recalcsAgree: recalcs.length === 2 && recalcs[0].batch_hash === recalcs[1].batch_hash,
    rulesPassed: gateResults.filter((g) => g.passed).length,
    rulesTotal: gateResults.length,
    openVariances: cases.filter((c) => c.status === 'pending' || c.status === 'explained').length,
    signedSteps: approvals.filter((a) => a.status === 'approved').length,
    totalSteps: approvals.length,
    hasPaymentFile: (fileRes.data ?? []).length > 0,
  };

  const stages = pipeline(run.status as RunStatus, ctx);
  const progress = gateProgress(run.status as RunStatus);
  const today = new Date().toISOString().slice(0, 10);
  const queue = decisionQueue({
    ...ctx,
    runId: run.id,
    status: run.status as RunStatus,
    missingAccounts: activeEmployees.filter((e) => !withAccount.has(e.id as string)).length,
    nextApprovalRole:
      (approvals.find((a) => a.status !== 'approved')?.role_label as string | undefined) ?? null,
  });

  const otHours = Math.round(items.reduce((s, i) => s + Number(i.ot_minutes ?? 0), 0) / 60);
  const deptNames = new Map((deptRes.data ?? []).map((d) => [d.id as string, d.name as string]));
  const depts = byDepartment(
    items.map((i) => ({ department_id: (i.department_id as string | null) ?? null, net: Number(i.net) })),
    deptNames
  );

  const { data: lineRows } = await supabase
    .from('payroll_lines')
    .select('component_code, kind, amount')
    .in('payroll_item_id', items.length > 0 ? items.map((i) => i.id as string) : ['']);
  const comp = composition(
    (lineRows ?? []).map((l) => ({
      component_code: (l.component_code as string | null) ?? null,
      kind: l.kind as string,
      amount: Number(l.amount),
    }))
  );

  const deltas = [
    delta('실지급', run.net_total, prevRegular?.net_total ?? null, formatRupiah),
    delta('지급총액', run.gross_total, prevRegular?.gross_total ?? null, formatRupiah),
    delta('인원', run.employee_count, prevRegular?.employee_count ?? null, (n) => `${n}명`),
  ];

  const closed = run.status === 'locked';

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">페이롤 홈</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {run.period} {RUN_TYPE_LABELS[run.run_type] ?? run.run_type} ·{' '}
            {closed ? '마감' : dDayLabel(run.pay_date, today)} · 컷오프 {run.cutoff_start} ~{' '}
            {run.cutoff_end} · 지급 {run.pay_date}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {runs.slice(0, 6).map((r) => (
            <Link
              key={r.id}
              href={`/?run=${r.id}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                r.id === run.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'
              }`}
            >
              {r.period}
              {r.run_type !== 'regular' && ` ${RUN_TYPE_LABELS[r.run_type] ?? r.run_type}`}
              <span className="ml-1 text-xs text-neutral-500">
                {STATUS_LABELS[r.status] ?? r.status}
              </span>
            </Link>
          ))}
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="게이트 진행" value={`${progress.cleared}/4`} sub={`${progress.percent}%`} />
        <Stat label="인원" value={`${run.employee_count}명`} />
        <Stat label={closed ? '실지급' : '실지급 예정'} value={formatRupiah(run.net_total)} />
        <Stat label="초과근무" value={`${otHours.toLocaleString('ko-KR')}h`} />
        <Stat label="소명 대기" value={`${ctx.openVariances}건`} sub={`전체 ${cases.length}건`} />
      </section>

      {/* --- 오늘 결정 큐 ---------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">오늘 결정 큐</h2>
        {queue.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            {closed
              ? '이 차수는 마감되었습니다. 대기 중인 결정이 없습니다.'
              : '지금 이 차수가 기다리고 있는 결정이 없습니다.'}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {queue.map((q) => (
              <div
                key={q.title}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
              >
                <div>
                  <p className="text-xs text-neutral-500">{q.tag}</p>
                  <p className="mt-0.5 text-sm font-medium">{q.title}</p>
                  {/* Every item says why it is here. A queue that only lists
                      counts makes people open each screen to find out. */}
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{q.basis}</p>
                </div>
                <Link href={q.href} className="text-sm text-blue-600 underline">
                  {q.linkLabel} →
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- 이번 달 지급 일정 ------------------------------------------------ */}
      {sameMonth.length > 1 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">{run.period} 지급 일정</h2>
          <p className="mt-1 text-sm text-neutral-500">
            차수마다 게이트를 따로 통과하고 이체파일도 따로 만들어집니다. 금액은 합산되지 않습니다.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sameMonth.map((r) => (
              <Link
                key={r.id}
                href={`/?run=${r.id}`}
                className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {RUN_TYPE_LABELS[r.run_type] ?? r.run_type}
                    {r.seq > 1 && ` #${r.seq}`}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </div>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                  지급 {r.pay_date} · {r.employee_count}명
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{formatRupiah(r.net_total)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* --- 4-게이트 파이프라인 ---------------------------------------------- */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">4-게이트 파이프라인</h2>
          <Link href={`/payroll/${run.id}`} className="text-sm text-blue-600 underline">
            차수 상세 →
          </Link>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div className="h-full bg-blue-600" style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          {stages.map((s) => (
            <div
              key={s.code}
              className={`rounded-lg border p-4 ${
                s.state === 'passed'
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : s.state === 'active'
                    ? 'border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950'
                    : 'border-neutral-200 opacity-60 dark:border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {s.code} {s.name}
                </span>
                <span className="text-xs text-neutral-500">
                  {s.state === 'passed' ? '통과' : s.state === 'active' ? '진행중' : '잠김'}
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{s.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- 구성과 부서 ------------------------------------------------------ */}
      {items.length > 0 && (
        <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="text-base font-semibold">지급 구성</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {comp.earnings.map((b) => (
                <Row key={b.label} label={b.label} value={formatRupiah(b.amount)} />
              ))}
              {comp.deductions.map((b) => (
                <Row key={b.label} label={b.label} value={`−${formatRupiah(b.amount)}`} muted />
              ))}
              <li className="flex justify-between border-t border-neutral-200 pt-2 font-medium dark:border-neutral-800">
                <span>실지급</span>
                <span className="tabular-nums">{formatRupiah(run.net_total)}</span>
              </li>
            </ul>
          </div>
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="text-base font-semibold">부서별 실지급액</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {depts.map((d) => (
                <Row key={d.label} label={d.label} value={formatRupiah(d.amount)} />
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* --- 전월 대비와 이벤트 ------------------------------------------------ */}
      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-base font-semibold">
            전 차수 대비{prevRegular && <span className="ml-2 text-xs font-normal text-neutral-500">{prevRegular.period}</span>}
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {deltas.map((d) => (
              <li key={d.label} className="flex items-center justify-between">
                <span className="text-neutral-500">{d.label}</span>
                <span className="tabular-nums">
                  {d.current}
                  {/* Null, not 0%, when there is no earlier run: a first month
                      has not held flat, it has nothing to compare against. */}
                  <span
                    className={`ml-2 text-xs ${
                      d.changePercent === null
                        ? 'text-neutral-400'
                        : d.changePercent >= 0
                          ? 'text-blue-600'
                          : 'text-red-600'
                    }`}
                  >
                    {d.changePercent === null
                      ? '비교 대상 없음'
                      : `${d.changePercent >= 0 ? '↑ +' : '↓ '}${d.changePercent.toFixed(1)}%`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-base font-semibold">차수 이벤트</h2>
          {(auditRes.data ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">기록된 이벤트가 없습니다.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {(auditRes.data ?? []).map((a, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 font-mono text-xs text-neutral-500">
                    {new Date(a.created_at as string).toLocaleString('ko-KR', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-right">{auditLabel(a.action as string)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
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

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <li className="flex justify-between">
      <span className="text-neutral-500">{label}</span>
      <span className={`tabular-nums ${muted ? 'text-neutral-500' : ''}`}>{value}</span>
    </li>
  );
}
