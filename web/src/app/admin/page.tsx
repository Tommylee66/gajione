import { createClient } from '@/lib/supabase/server';
import { formatRupiah } from '@/lib/format';
import { COMPANY_STATUS_LABELS } from '@/lib/billing/invoice';
import { CustomerTable, type CustomerRow } from '@/components/admin-customers';
import { SignupQueue, type SignupRow } from '@/components/admin-signups';

export const dynamic = 'force-dynamic';

export default async function AdminCustomers() {
  const supabase = await createClient();
  const [coRes, subRes, planRes, empRes, invRes, runRes, signupRes, umkRes] = await Promise.all([
    supabase.from('companies').select('*').order('name'),
    supabase.from('subscriptions').select('*').is('ended_on', null),
    supabase.from('plans').select('id, code, name'),
    supabase.from('employees').select('company_id, is_active'),
    supabase.from('billing_invoices').select('company_id, period, total_amount, status'),
    supabase.from('payroll_runs').select('company_id, status, period'),
    supabase.from('signup_requests').select('*').order('created_at', { ascending: false }),
    supabase.from('umk_rates').select('region').order('region'),
  ]);

  const plans = new Map((planRes.data ?? []).map((p) => [p.id as string, p.name as string]));
  const headcount = new Map<string, number>();
  for (const e of empRes.data ?? []) {
    if (!e.is_active) continue;
    const k = e.company_id as string;
    headcount.set(k, (headcount.get(k) ?? 0) + 1);
  }

  const latestPeriod = [...new Set((invRes.data ?? []).map((i) => i.period as string))].sort().pop();
  const latestInvoice = new Map(
    (invRes.data ?? [])
      .filter((i) => i.period === latestPeriod)
      .map((i) => [i.company_id as string, Number(i.total_amount)])
  );

  const customers: CustomerRow[] = (coRes.data ?? []).map((c) => {
    const sub = (subRes.data ?? []).find((s) => s.company_id === c.id);
    return {
      id: c.id as string,
      name: c.name as string,
      industry: (c.industry as string | null) ?? null,
      status: c.status as string,
      joined_at: c.joined_at as string,
      headcount: headcount.get(c.id as string) ?? 0,
      plan: sub ? (plans.get(sub.plan_id as string) ?? '—') : null,
      monthly: latestInvoice.get(c.id as string) ?? null,
      cs_owner: (c.cs_owner as string | null) ?? null,
      contract_started_on: (c.contract_started_on as string | null) ?? null,
      contract_renews_on: (c.contract_renews_on as string | null) ?? null,
      churn_reason: (c.churn_reason as string | null) ?? null,
      lending_enabled: Boolean(c.lending_enabled),
    };
  });

  const byStatus = (s: string) => customers.filter((c) => c.status === s).length;
  const totalHeadcount = customers.reduce((s, c) => s + c.headcount, 0);
  const monthlyTotal = customers.reduce((s, c) => s + (c.monthly ?? 0), 0);
  // What the payroll batches across every tenant are doing right now. The
  // operator's job is noticing the one that is stuck, not the thirty-one that
  // are fine.
  const stuck = (runRes.data ?? []).filter(
    (r) => r.status !== 'locked' && r.status !== 'cancelled'
  ).length;

  const signups: SignupRow[] = (signupRes.data ?? []) as unknown as SignupRow[];
  const regions = [...new Set((umkRes.data ?? []).map((u) => u.region as string))];

  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="활성 고객사" value={`${byStatus('active')}개`} />
        <Stat label="체험중" value={`${byStatus('trial')}개`} />
        <Stat label="해지예정" value={`${byStatus('churning')}개`} />
        <Stat label="전체 관리 직원" value={`${totalHeadcount.toLocaleString('ko-KR')}명`} />
        <Stat
          label={latestPeriod ? `${latestPeriod} 청구` : '청구'}
          value={monthlyTotal > 0 ? formatRupiah(monthlyTotal) : '—'}
        />
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">배치 처리 현황</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          진행 중인 급여 차수 {stuck}건 · 마감{' '}
          {(runRes.data ?? []).filter((r) => r.status === 'locked').length}건
        </p>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">고객사 관리</h2>
          <p className="text-sm text-neutral-500">
            전체 {customers.length}개 · {COMPANY_STATUS_LABELS.active} {byStatus('active')}
          </p>
        </div>
        <CustomerTable rows={customers} />
      </section>

      <SignupQueue
        rows={signups}
        plans={(planRes.data ?? []).map((p) => ({ id: p.id as string, name: p.name as string }))}
        regions={regions}
      />
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
