'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  buildInvoice,
  validatePricing,
  type PlanPricing,
  type VolumeTier,
} from '@/lib/billing/invoice';

/**
 * The operator console.
 *
 * An operator is a user attached to no tenant — the database's own definition,
 * which the app has to agree with or RLS will filter writes into silent
 * no-ops. Checked here the same way the rate uploads check it.
 */
async function requireOperator() {
  const session = await requireSession();
  if (session.role !== 'operator_admin') {
    throw new Error('Forbidden: 운영사 계정만 사용할 수 있습니다.');
  }
  if (session.company_id || session.lender_id) {
    throw new Error('Forbidden: 운영사 계정은 특정 회사·금융기관에 소속되지 않아야 합니다.');
  }
  return session;
}

export interface AdminResult {
  ok: boolean;
  error?: string;
  generated?: number;
  total?: number;
}

export async function updatePlanPricingAction(input: {
  planId: string;
  baseFee: number;
  perEmployeeFee: number;
  whitelabelFee: number;
  whitelabelMonthlyFee: number;
  annualPrepayDiscount: number;
  volumeTiers: VolumeTier[];
}): Promise<AdminResult> {
  try {
    await requireOperator();
    const supabase = await createClient();

    const { data: plan } = await supabase
      .from('plans')
      .select('code, name')
      .eq('id', input.planId)
      .maybeSingle();
    if (!plan) return { ok: false, error: '요금제를 찾을 수 없습니다.' };

    const problems = validatePricing({
      code: plan.code as string,
      name: plan.name as string,
      base_fee: input.baseFee,
      per_employee_fee: input.perEmployeeFee,
      whitelabel_fee: input.whitelabelFee,
      whitelabel_monthly_fee: input.whitelabelMonthlyFee,
      volume_tiers: input.volumeTiers,
      annual_prepay_discount: input.annualPrepayDiscount,
    });
    if (problems.length > 0) {
      return { ok: false, error: problems.map((p) => p.reason).join(' · ') };
    }

    const { data: touched, error } = await supabase
      .from('plans')
      .update({
        base_fee: input.baseFee,
        per_employee_fee: input.perEmployeeFee,
        whitelabel_fee: input.whitelabelFee,
        whitelabel_monthly_fee: input.whitelabelMonthlyFee,
        annual_prepay_discount: input.annualPrepayDiscount,
        // Sorted on the way in, so the stored order matches the order the
        // calculation walks them in and the screen cannot show one thing while
        // the invoice does another.
        volume_tiers: [...input.volumeTiers].sort((a, b) => a.over - b.over),
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.planId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'PLAN_PRICING_UPDATED',
      p_target_table: 'plans',
      p_target_id: input.planId,
      p_details: { code: plan.code, ...input },
    });

    revalidatePath('/admin/billing');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/**
 * Builds the month's invoices.
 *
 * Headcount is taken from the payroll run for the period where one exists, and
 * from the live employee list otherwise — because the run is what the customer
 * was actually served for that month, and a headcount read today would bill
 * March at September's numbers.
 *
 * Re-runnable while the invoices are drafts. Once one is issued it is a
 * document somebody has, and regenerating it would change a number already
 * sent.
 */
export async function generateInvoicesAction(period: string): Promise<AdminResult> {
  try {
    await requireOperator();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return { ok: false, error: '청구월은 YYYY-MM 형식이어야 합니다.' };
    }
    const supabase = await createClient();

    const { data: existing } = await supabase
      .from('billing_invoices')
      .select('id, status')
      .eq('period', period);
    const issued = (existing ?? []).filter((i) => i.status !== 'draft');
    if (issued.length > 0) {
      return {
        ok: false,
        error: `${period}에 이미 발행된 청구서가 ${issued.length}건 있습니다. 초안만 다시 생성할 수 있습니다.`,
      };
    }

    const [companyRes, subRes, planRes, runRes, empRes] = await Promise.all([
      supabase.from('companies').select('id, name, status'),
      supabase.from('subscriptions').select('*').is('ended_on', null),
      supabase.from('plans').select('*').eq('active', true),
      supabase
        .from('payroll_runs')
        .select('company_id, period, employee_count, run_type')
        .eq('period', period)
        .eq('run_type', 'regular'),
      supabase.from('employees').select('company_id, is_active'),
    ]);

    const plans = new Map(
      (planRes.data ?? []).map((p) => [
        p.id as string,
        {
          code: p.code as string,
          name: p.name as string,
          base_fee: Number(p.base_fee),
          per_employee_fee: Number(p.per_employee_fee),
          whitelabel_fee: Number(p.whitelabel_fee),
          whitelabel_monthly_fee: Number(p.whitelabel_monthly_fee),
          volume_tiers: (p.volume_tiers as VolumeTier[]) ?? [],
          annual_prepay_discount: Number(p.annual_prepay_discount),
        } as PlanPricing,
      ])
    );

    const runHeadcount = new Map(
      (runRes.data ?? []).map((r) => [r.company_id as string, Number(r.employee_count)])
    );
    const liveHeadcount = new Map<string, number>();
    for (const e of empRes.data ?? []) {
      if (!e.is_active) continue;
      const k = e.company_id as string;
      liveHeadcount.set(k, (liveHeadcount.get(k) ?? 0) + 1);
    }

    // Only customers that were live in the period get billed. A closed one
    // does not, and a trial does not either — a trial that quietly invoices is
    // the worst kind of surprise to send a prospect.
    const billable = (companyRes.data ?? []).filter(
      (c) => c.status === 'active' || c.status === 'churning'
    );

    const rows: Record<string, unknown>[] = [];
    const skipped: string[] = [];

    for (const c of billable) {
      const sub = (subRes.data ?? []).find((s) => s.company_id === c.id);
      if (!sub) {
        skipped.push(`${c.name}: 구독 정보 없음`);
        continue;
      }
      const plan = plans.get(sub.plan_id as string);
      if (!plan) {
        skipped.push(`${c.name}: 요금제를 찾을 수 없음`);
        continue;
      }

      const count = runHeadcount.get(c.id as string) ?? liveHeadcount.get(c.id as string) ?? 0;
      // The setup fee is charged in the month the add-on started, which is the
      // month the subscription carrying it began.
      const setupDue =
        Boolean(sub.whitelabel) && String(sub.started_on).slice(0, 7) === period;

      const invoice = buildInvoice({
        plan,
        employeeCount: count,
        whitelabel: Boolean(sub.whitelabel),
        whitelabelSetupDue: setupDue,
        annualPrepay: Boolean(sub.annual_prepay),
        contractDiscountPercent: Number(sub.discount_rate),
      });

      rows.push({
        company_id: c.id as string,
        period,
        plan_code: plan.code,
        employee_count: invoice.employeeCount,
        base_amount: invoice.baseAmount,
        per_employee_amount: invoice.perEmployeeAmount,
        whitelabel_amount: invoice.whitelabelAmount,
        discount_amount: invoice.discountAmount,
        total_amount: invoice.totalAmount,
        breakdown: {
          ...invoice.breakdown,
          // Says where the headcount came from, because the two sources can
          // differ and the difference is the first thing queried.
          headcount_source: runHeadcount.has(c.id as string) ? 'payroll_run' : 'live_employees',
        },
        status: 'draft',
      });
    }

    if (rows.length === 0) {
      return {
        ok: false,
        error: skipped.length > 0 ? `생성할 수 없습니다: ${skipped.join(' · ')}` : '청구 대상 고객사가 없습니다.',
      };
    }

    // Drafts are replaced wholesale, which is what re-running means.
    await supabase.from('billing_invoices').delete().eq('period', period).eq('status', 'draft');
    const { error } = await supabase.from('billing_invoices').insert(rows);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'INVOICES_GENERATED',
      p_target_table: 'billing_invoices',
      p_target_id: period,
      p_details: {
        period,
        count: rows.length,
        total: rows.reduce((s, r) => s + Number(r.total_amount), 0),
        skipped,
      },
    });

    revalidatePath('/admin/billing');
    return {
      ok: true,
      generated: rows.length,
      total: rows.reduce((s, r) => s + Number(r.total_amount), 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '생성에 실패했습니다.' };
  }
}

export async function issueInvoicesAction(period: string): Promise<AdminResult> {
  try {
    await requireOperator();
    const supabase = await createClient();

    const { data: drafts } = await supabase
      .from('billing_invoices')
      .select('id')
      .eq('period', period)
      .eq('status', 'draft');
    if ((drafts ?? []).length === 0) return { ok: false, error: '발행할 초안이 없습니다.' };

    const { error } = await supabase
      .from('billing_invoices')
      .update({
        status: 'issued',
        issued_on: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq('period', period)
      .eq('status', 'draft');
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'INVOICES_ISSUED',
      p_target_table: 'billing_invoices',
      p_target_id: period,
      p_details: { period, count: (drafts ?? []).length },
    });

    revalidatePath('/admin/billing');
    return { ok: true, generated: (drafts ?? []).length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '발행에 실패했습니다.' };
  }
}

export async function updateCustomerAction(input: {
  companyId: string;
  status: string;
  csOwner: string;
  contractStartedOn: string;
  contractRenewsOn: string;
  churnReason: string;
  lendingEnabled: boolean;
}): Promise<AdminResult> {
  try {
    await requireOperator();
    const supabase = await createClient();

    const valid = ['active', 'trial', 'churning', 'suspended', 'closed'];
    if (!valid.includes(input.status)) return { ok: false, error: '알 수 없는 상태입니다.' };
    // A churn with no reason on it is a customer nobody learned anything from.
    if (input.status === 'churning' && !input.churnReason.trim()) {
      return { ok: false, error: '해지예정으로 바꾸려면 사유를 입력하세요.' };
    }
    for (const [label, v] of [
      ['계약 시작일', input.contractStartedOn],
      ['갱신일', input.contractRenewsOn],
    ] as const) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return { ok: false, error: `${label} 형식이 올바르지 않습니다.` };
      }
    }
    if (
      input.contractStartedOn &&
      input.contractRenewsOn &&
      input.contractRenewsOn < input.contractStartedOn
    ) {
      return { ok: false, error: '갱신일이 계약 시작일보다 빠릅니다.' };
    }

    const { data: touched, error } = await supabase
      .from('companies')
      .update({
        status: input.status,
        cs_owner: input.csOwner.trim() || null,
        contract_started_on: input.contractStartedOn || null,
        contract_renews_on: input.contractRenewsOn || null,
        churn_reason: input.status === 'churning' ? input.churnReason : null,
        lending_enabled: input.lendingEnabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.companyId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'CUSTOMER_UPDATED',
      p_target_table: 'companies',
      p_target_id: input.companyId,
      p_details: input,
    });

    revalidatePath('/admin');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}
