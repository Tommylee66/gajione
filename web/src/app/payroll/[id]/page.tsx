import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { formatRupiah } from '@/lib/format';
import { GatePanel, type StoredGateResult, type VarianceCase } from '@/components/gate-panel';
import {
  PayoutPanel,
  type ApprovalView,
  type FilingView,
  type PaymentFileView,
} from '@/components/payout-panel';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const supabase = await createClient();

  const [runRes, itemRes, recalcRes, gateRes, caseRes, approvalRes, fileRes, filingRes] =
    await Promise.all([
      supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle(),
      supabase.from('payroll_items').select('*').eq('run_id', id).order('employee_no'),
      supabase.from('payroll_recalcs').select('pass_no, batch_hash, matched_count, mismatch_count').eq('run_id', id).order('pass_no'),
      supabase.from('gate_results').select('rule_code, passed, severity, detail').eq('run_id', id),
      supabase.from('variance_cases').select('*').eq('run_id', id),
      supabase
        .from('approvals')
        .select('step_no, role_label, approver_id, signed_at, status')
        .eq('run_id', id)
        .order('step_no'),
      supabase
        .from('payment_files')
        .select('id, file_hash, total_amount, record_count, status, generated_at')
        .eq('run_id', id)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('tax_filings').select('kind, period, total_amount, status').eq('run_id', id),
    ]);

  const run = runRes.data;
  if (!run) notFound();
  const items = itemRes.data ?? [];
  // Names are joined in here rather than duplicated onto the case row: the
  // variance table stores only the employee id, and the payslip beside it
  // already carries the frozen name.
  const nameById = new Map(
    items.map((i) => [i.employee_id as string, { no: i.employee_no as string, name: i.employee_name as string }])
  );
  const cases: VarianceCase[] = (caseRes.data ?? []).map((c) => ({
    id: c.id as string,
    employee_id: c.employee_id as string,
    employee_no: nameById.get(c.employee_id as string)?.no ?? '—',
    employee_name: nameById.get(c.employee_id as string)?.name ?? '(알 수 없음)',
    prev_net: Number(c.prev_net ?? 0),
    curr_net: Number(c.curr_net ?? 0),
    change_rate: Number(c.change_rate ?? 0),
    line_comment: (c.line_comment as string | null) ?? null,
    line_submitted_at: (c.line_submitted_at as string | null) ?? null,
    hr_decision: (c.hr_decision as string | null) ?? null,
    hr_comment: (c.hr_comment as string | null) ?? null,
    hr_decided_at: (c.hr_decided_at as string | null) ?? null,
    status: c.status as string,
  }));
  const canRun = ['hr_admin', 'payroll_staff', 'operator_admin'].includes(session.role);
  const canExplain = ['line_manager', 'hr_admin', 'operator_admin'].includes(session.role);
  const canDecide = ['hr_admin', 'operator_admin'].includes(session.role);
  const recalcs = recalcRes.data ?? [];
  const hashesAgree = recalcs.length === 2 && recalcs[0].batch_hash === recalcs[1].batch_hash;

  // Signer names are looked up rather than stored on the approval row: the
  // signature's meaning is the user id and the moment, and a name copied at
  // signing time would drift from the person record.
  const approvalRows = approvalRes.data ?? [];
  const signerIds = [
    ...new Set(approvalRows.map((a) => a.approver_id as string | null).filter(Boolean)),
  ] as string[];
  const signerNames = new Map<string, string>();
  if (signerIds.length > 0) {
    const { data: signers } = await supabase
      .from('users')
      .select('id, full_name')
      .in('id', signerIds);
    for (const s of signers ?? []) signerNames.set(s.id as string, s.full_name as string);
  }
  const approvals: ApprovalView[] = approvalRows.map((a) => ({
    step_no: a.step_no as number,
    role_label: a.role_label as string,
    approver_id: (a.approver_id as string | null) ?? null,
    approver_name: a.approver_id ? (signerNames.get(a.approver_id as string) ?? null) : null,
    signed_at: (a.signed_at as string | null) ?? null,
    status: a.status as string,
  }));

  const { data: slipRows } = await supabase
    .from('payslips')
    .select('channel, status, opened_at')
    .in('payroll_item_id', items.length > 0 ? items.map((i) => i.id as string) : ['']);
  const byChannel = new Map<string, { queued: number; opened: number }>();
  for (const s of slipRows ?? []) {
    const key = s.channel as string;
    const entry = byChannel.get(key) ?? { queued: 0, opened: 0 };
    entry.queued += 1;
    if (s.opened_at) entry.opened += 1;
    byChannel.set(key, entry);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <Link href="/payroll" className="text-sm text-blue-600 underline">← 급여 차수</Link>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold">{run.period} 급여</h1>
        <p className="mt-1 text-sm text-neutral-500">
          컷오프 {run.cutoff_start} ~ {run.cutoff_end} · 지급 {run.pay_date}
        </p>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="인원" value={`${run.employee_count}명`} />
        <Stat label="지급총액" value={formatRupiah(run.gross_total)} />
        <Stat label="공제" value={formatRupiah(run.deduction_total)} />
        <Stat label="실지급" value={formatRupiah(run.net_total)} />
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">G2 · 계산 정합성</h2>
        <div className="mt-3 space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <p>
            병렬 재계산 일치:{' '}
            <span className={hashesAgree ? '' : 'font-medium text-red-600'}>
              {recalcs.length < 2 ? '미실행' : hashesAgree ? `${items.length}/${items.length}` : '불일치'}
            </span>
          </p>
          <p className="text-neutral-500">
            배치 해시 <span className="font-mono">{run.batch_hash ?? '—'}</span>
          </p>
          {/* Written onto the run, not looked up. A rate change after this
              point must not move what these payslips say. */}
          <p className="text-neutral-500">
            세율표 {run.tax_table_version ?? '—'} · BPJS {run.bpjs_rate_version ?? '—'}
          </p>
        </div>
      </section>

      <GatePanel
        runId={id}
        runStatus={run.status as string}
        results={(gateRes.data ?? []) as StoredGateResult[]}
        cases={cases}
        canRun={canRun}
        canExplain={canExplain}
        canDecide={canDecide}
      />

      <PayoutPanel
        runId={id}
        runStatus={run.status as string}
        approvals={approvals}
        paymentFile={(fileRes.data as PaymentFileView | null) ?? null}
        filings={(filingRes.data ?? []) as FilingView[]}
        payslips={{
          total: (slipRows ?? []).length,
          byChannel: [...byChannel.entries()].map(([channel, v]) => ({ channel, ...v })),
        }}
        employeeCount={items.length}
        canAct={canRun}
        currentUserId={session.id}
      />

      <section className="mt-10">
        <h2 className="text-lg font-semibold">직원별 내역</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">사번</th>
                <th className="px-3 py-2 font-medium">이름</th>
                <th className="px-3 py-2 text-right font-medium">근무일</th>
                <th className="px-3 py-2 text-right font-medium">OT</th>
                <th className="px-3 py-2 text-right font-medium">지급총액</th>
                <th className="px-3 py-2 text-right font-medium">공제</th>
                <th className="px-3 py-2 text-right font-medium">실지급</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-neutral-500">
                    아직 계산되지 않았습니다.
                  </td>
                </tr>
              )}
              {items.map((i) => (
                <tr key={i.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">
                    <Link href={`/payroll/${id}/slip/${i.id}`} className="text-blue-600 underline">
                      {i.employee_no as string}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{i.employee_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{i.work_days}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {i.ot_minutes ? `${Math.floor(i.ot_minutes / 60)}h ${i.ot_minutes % 60}m` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(i.gross)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(i.deduction_total)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatRupiah(i.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
