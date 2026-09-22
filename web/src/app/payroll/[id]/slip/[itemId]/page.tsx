import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { formatRupiah } from '@/lib/format';
import { PrintButton } from '@/components/print-button';

export default async function PayslipPage({
  params,
}: {
  params: Promise<{ id: string; itemId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id: runId, itemId } = await params;
  const supabase = await createClient();

  const [itemRes, lineRes, otRes, runRes, companyRes] = await Promise.all([
    supabase.from('payroll_items').select('*').eq('id', itemId).maybeSingle(),
    supabase
      .from('payroll_lines')
      .select('*')
      .eq('payroll_item_id', itemId)
      .order('sort_order'),
    supabase.from('payroll_ot_lines').select('*').eq('payroll_item_id', itemId),
    supabase.from('payroll_runs').select('*').eq('id', runId).maybeSingle(),
    supabase.from('companies').select('name, npwp, address').maybeSingle(),
  ]);

  const item = itemRes.data;
  const run = runRes.data;
  if (!item || !run) notFound();

  // An employee may open their own payslip and nobody else's. RLS enforces the
  // same rule on the rows; this is what turns a blocked read into a clear 404
  // rather than an empty page.
  const isOwner = session.employee_id === item.employee_id;
  const isStaff = ['hr_admin', 'payroll_staff', 'operator_admin'].includes(session.role);
  if (!isOwner && !isStaff) notFound();

  const lines = lineRes.data ?? [];
  const earnings = lines.filter((l) => l.kind === 'earning');
  const deductions = lines.filter((l) => l.kind === 'deduction');
  const otLines = otRes.data ?? [];
  const company = companyRes.data;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/payroll/${runId}`} className="text-sm text-blue-600 underline">
          ← 차수 상세
        </Link>
        <PrintButton />
      </div>

      <article className="mt-6 rounded-lg border border-neutral-200 p-8 print:mt-0 print:rounded-none print:border-0 print:p-0 dark:border-neutral-800">
        <header className="border-b border-neutral-200 pb-5 dark:border-neutral-800">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">급여명세서</h1>
              <p className="text-sm text-neutral-500">Slip Gaji</p>
            </div>
            <div className="text-right text-sm">
              <p className="font-medium">{company?.name ?? '—'}</p>
              {company?.npwp && <p className="text-neutral-500">NPWP {company.npwp}</p>}
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
            <Field label="사번" value={item.employee_no as string} />
            <Field label="성명" value={item.employee_name as string} />
            <Field label="차수" value={run.period as string} />
            <Field label="지급일" value={run.pay_date as string} />
            <Field
              label="산정기간"
              value={`${run.cutoff_start} ~ ${run.cutoff_end}`}
            />
            <Field label="근무일수" value={`${item.work_days}일`} />
            <Field
              label="초과근무"
              value={
                item.ot_minutes
                  ? `${Math.floor(Number(item.ot_minutes) / 60)}시간 ${Number(item.ot_minutes) % 60}분`
                  : '—'
              }
            />
            <Field label="PTKP" value={(item.ptkp_status as string) ?? '—'} />
          </dl>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2">
          <LineTable title="지급" lines={earnings} total={Number(item.gross)} />
          <LineTable title="공제" lines={deductions} total={Number(item.deduction_total)} negative />
        </div>

        <div className="mt-6 rounded-lg bg-neutral-50 p-4 dark:bg-neutral-900">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">실지급액</span>
            <span className="text-xl font-semibold tabular-nums">
              {formatRupiah(Number(item.net))}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            지급 {formatRupiah(Number(item.gross))} − 공제{' '}
            {formatRupiah(Number(item.deduction_total))}
          </p>
        </div>

        {otLines.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold">초과근무 내역</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="py-1 font-medium">구간</th>
                  <th className="py-1 text-right font-medium">배율</th>
                  <th className="py-1 text-right font-medium">시간</th>
                  <th className="py-1 text-right font-medium">시급</th>
                  <th className="py-1 text-right font-medium">금액</th>
                </tr>
              </thead>
              <tbody>
                {otLines.map((o) => (
                  <tr key={o.id} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="py-1">{o.bracket_label}</td>
                    <td className="py-1 text-right tabular-nums">{Number(o.multiplier)}×</td>
                    <td className="py-1 text-right tabular-nums">{Number(o.hours).toFixed(1)}h</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatRupiah(Number(o.hourly_rate))}
                    </td>
                    <td className="py-1 text-right tabular-nums">{formatRupiah(Number(o.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* The citation is on the payslip because a labour inspector reads
                it there, not in the system. */}
            <p className="mt-2 text-xs text-neutral-500">
              시급 = 월 급여 × 1/173 · {otLines[0]?.legal_basis ?? 'Kepmenakertrans 102/2004'}
            </p>
          </section>
        )}

        <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500 dark:border-neutral-800">
          <p>
            세율표 {(run.tax_table_version as string) ?? '—'} · BPJS{' '}
            {(run.bpjs_rate_version as string) ?? '—'} · 배치{' '}
            <span className="font-mono">{((run.batch_hash as string) ?? '—').slice(0, 12)}</span>
          </p>
          <p className="mt-1">
            이 명세서는 위 버전의 요율로 산정되었습니다. 이후 요율이 개정되어도 본 명세서의 금액은
            변경되지 않습니다.
          </p>
        </footer>
      </article>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

function LineTable({
  title,
  lines,
  total,
  negative,
}: {
  title: string;
  lines: Record<string, unknown>[];
  total: number;
  negative?: boolean;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {lines.map((l) => (
            <tr key={l.id as string} className="border-b border-neutral-100 dark:border-neutral-900">
              <td className="py-1.5">
                {l.component_name as string}
                {/* Quantity and rate are shown when they explain the figure —
                    "how did 184,393 happen" is the question a payslip has to
                    answer without anyone opening the system. */}
                {l.quantity !== null && (
                  <span className="ml-1 text-xs text-neutral-500">
                    ({Number(l.quantity).toFixed(Number(l.quantity) % 1 === 0 ? 0 : 1)}
                    {l.component_code === 'OT' ? '시간' : ''}
                    {l.rate !== null && ` × ${formatRupiah(Number(l.rate))}`})
                  </span>
                )}
                {l.quantity === null && l.rate !== null && Number(l.rate) < 1 && (
                  <span className="ml-1 text-xs text-neutral-500">
                    ({(Number(l.rate) * 100).toFixed(2)}%)
                  </span>
                )}
                {l.legal_basis !== null && (
                  <span className="ml-1 text-xs text-neutral-400">{l.legal_basis as string}</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {negative && '−'}
                {formatRupiah(Number(l.amount))}
              </td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td className="py-3 text-neutral-500">없음</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-neutral-300 dark:border-neutral-700">
            <td className="py-1.5 font-medium">합계</td>
            <td className="py-1.5 text-right font-semibold tabular-nums">
              {negative && '−'}
              {formatRupiah(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
