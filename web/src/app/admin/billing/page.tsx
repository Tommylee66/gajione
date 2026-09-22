import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { INVOICE_STATUS_LABELS, type VolumeTier } from '@/lib/billing/invoice';
import { BillingPanel, type PlanRow, type InvoiceRow } from '@/components/admin-billing';

export const dynamic = 'force-dynamic';

export default async function AdminBilling() {
  const supabase = await createClient();
  const [planRes, invRes, coRes, subRes] = await Promise.all([
    supabase.from('plans').select('*').eq('active', true).order('base_fee'),
    supabase.from('billing_invoices').select('*').order('period', { ascending: false }),
    supabase.from('companies').select('id, name'),
    supabase.from('subscriptions').select('company_id, annual_prepay, whitelabel, discount_rate').is('ended_on', null),
  ]);

  const names = new Map((coRes.data ?? []).map((c) => [c.id as string, c.name as string]));
  const plans: PlanRow[] = (planRes.data ?? []).map((p) => ({
    id: p.id as string,
    code: p.code as string,
    name: p.name as string,
    base_fee: Number(p.base_fee),
    per_employee_fee: Number(p.per_employee_fee),
    whitelabel_fee: Number(p.whitelabel_fee),
    whitelabel_monthly_fee: Number(p.whitelabel_monthly_fee),
    annual_prepay_discount: Number(p.annual_prepay_discount),
    volume_tiers: ((p.volume_tiers as VolumeTier[]) ?? []).map((t) => ({
      over: Number(t.over),
      discount_percent: Number(t.discount_percent),
    })),
  }));

  const periods = [...new Set((invRes.data ?? []).map((i) => i.period as string))].sort().reverse();
  const invoices: InvoiceRow[] = (invRes.data ?? []).map((i) => ({
    id: i.id as string,
    period: i.period as string,
    company: names.get(i.company_id as string) ?? '(알 수 없음)',
    plan_code: (i.plan_code as string | null) ?? null,
    employee_count: Number(i.employee_count),
    base_amount: Number(i.base_amount),
    per_employee_amount: Number(i.per_employee_amount),
    whitelabel_amount: Number(i.whitelabel_amount),
    discount_amount: Number(i.discount_amount),
    total_amount: Number(i.total_amount),
    status: i.status as string,
    breakdown: (i.breakdown as Record<string, unknown>) ?? {},
  }));

  const latest = periods[0];
  const latestTotal = invoices
    .filter((i) => i.period === latest)
    .reduce((s, i) => s + i.total_amount, 0);
  const issued = invoices.filter((i) => i.period === latest && i.status !== 'draft').length;
  const prepayCount = (subRes.data ?? []).filter((s) => s.annual_prepay).length;

  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={latest ? `${latest} 청구 총액` : '청구 총액'} value={latestTotal > 0 ? formatRupiah(latestTotal) : '—'} />
        <Stat
          label="평균 ARPU"
          value={
            invoices.filter((i) => i.period === latest).length > 0
              ? formatRupiah(latestTotal / invoices.filter((i) => i.period === latest).length)
              : '—'
          }
        />
        <Stat label="연간 선결제" value={`${prepayCount}개사`} />
        <Stat
          label="발행 상태"
          value={latest ? `${issued} / ${invoices.filter((i) => i.period === latest).length} 발행` : '—'}
        />
      </section>

      <BillingPanel plans={plans} invoices={invoices} periods={periods} />

      {invoices.length === 0 && (
        <p className="mt-6 text-sm text-neutral-500">
          아직 생성된 청구서가 없습니다. 청구월을 입력하고 생성하세요. 상태{' '}
          {INVOICE_STATUS_LABELS.draft}로 만들어지며, 검토 후 발행합니다.
        </p>
      )}
    </>
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
