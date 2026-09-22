import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { requireMe } from '@/lib/me/data';
import { PayslipView, type SlipLine } from '@/components/me-payslip';

export const dynamic = 'force-dynamic';

export default async function MePayslip({
  searchParams,
}: {
  searchParams: Promise<{ item?: string }>;
}) {
  await requireMe();
  const { item: requested } = await searchParams;
  const supabase = await createClient();

  const [itemRes, runRes, slipRes] = await Promise.all([
    supabase
      .from('payroll_items')
      .select('id, run_id, gross, deduction_total, net, work_days, ot_minutes')
      .order('created_at', { ascending: false }),
    supabase.from('payroll_runs').select('id, period, pay_date, status'),
    supabase.from('payslips').select('payroll_item_id, opened_at, channel, status'),
  ]);

  const runs = new Map(
    (runRes.data ?? []).map((r) => [
      r.id as string,
      { period: r.period as string, pay_date: r.pay_date as string, status: r.status as string },
    ])
  );
  const items = (itemRes.data ?? []).sort((a, b) =>
    String(runs.get(b.run_id as string)?.period ?? '').localeCompare(
      String(runs.get(a.run_id as string)?.period ?? '')
    )
  );

  if (items.length === 0) {
    return (
      <>
        <h1 className="text-xl font-semibold">급여명세</h1>
        <p className="mt-3 text-sm text-neutral-500">아직 발행된 명세서가 없습니다.</p>
      </>
    );
  }

  const selected = items.find((i) => i.id === requested) ?? items[0];
  const run = runs.get(selected.run_id as string);

  const { data: lineRows } = await supabase
    .from('payroll_lines')
    .select('component_code, component_name, kind, amount, legal_basis')
    .eq('payroll_item_id', selected.id as string);

  const lines: SlipLine[] = (lineRows ?? []).map((l) => ({
    code: (l.component_code as string | null) ?? '',
    name: (l.component_name as string | null) ?? (l.component_code as string) ?? '항목',
    kind: l.kind as string,
    amount: Number(l.amount),
    legal_basis: (l.legal_basis as string | null) ?? null,
  }));

  const slip = (slipRes.data ?? []).find((s) => s.payroll_item_id === selected.id);

  return (
    <>
      <h1 className="text-xl font-semibold">급여명세</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {run?.period} · 지급 {run?.pay_date}
        {run?.status !== 'locked' && ' · 확정 전'}
      </p>

      {items.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.slice(0, 6).map((i) => (
            <a
              key={i.id as string}
              href={`/me/payslip?item=${i.id}`}
              className={`rounded-md border px-3 py-1.5 text-xs ${
                i.id === selected.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'
              }`}
            >
              {runs.get(i.run_id as string)?.period}
            </a>
          ))}
        </div>
      )}

      <PayslipView
        payrollItemId={selected.id as string}
        net={Number(selected.net)}
        gross={Number(selected.gross)}
        deductionTotal={Number(selected.deduction_total)}
        workDays={Number(selected.work_days)}
        otMinutes={Number(selected.ot_minutes)}
        lines={lines}
        alreadyOpened={Boolean(slip?.opened_at)}
        delivered={Boolean(slip)}
      />

      <p className="mt-4 text-xs text-neutral-500">
        실지급액 {formatRupiah(selected.net)} · 이 명세서에 대한 문의는 인사팀으로 해주세요.
      </p>
    </>
  );
}
