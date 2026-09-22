'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { parseTaxTableCsv, type TaxParseError } from '@/lib/rates/tax-table-csv';
import { pointsForWeight, validateWeights } from '@/lib/credit/scoring';

/**
 * Statutory rates are the operator's to change, not a tenant's. BPJS
 * percentages and the tax schedule come from national regulation; a customer
 * editing them would be editing the law.
 *
 * The gate thresholds below are the exception — a variance band and a loan
 * ceiling are company policy, so hr_admin owns those.
 */
async function requireOperator() {
  const session = await requireSession();
  if (session.role !== 'operator_admin') {
    throw new Error('Forbidden: 법정 요율은 운영사만 변경할 수 있습니다.');
  }
  // The database's is_operator() means "attached to no tenant", not "holds the
  // operator role". Checking only the role here would let an account the
  // database does not consider an operator through the app, and RLS would then
  // filter the write into a silent no-op.
  if (session.company_id || session.lender_id) {
    throw new Error(
      'Forbidden: 운영사 계정은 특정 회사·금융기관에 소속되지 않아야 합니다.'
    );
  }
  return session;
}

async function requireHrAdmin() {
  const session = await requireSession();
  if (session.role !== 'hr_admin' && session.role !== 'operator_admin') {
    throw new Error('Forbidden: 정책을 변경할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface Result {
  ok: boolean;
  error?: string;
  parseErrors?: TaxParseError[];
  bands?: number;
  categories?: string[];
}

/**
 * Loads a PPh 21 schedule under a new version tag.
 *
 * Nothing is replaced. Past runs recorded which version they computed with,
 * and a payslip has to stay reproducible — so a new schedule is a new version
 * with its own effective date, and the previous one is closed off rather than
 * overwritten.
 */
export async function uploadTaxTableAction(input: {
  csvText: string;
  version: string;
  effectiveFrom: string;
}): Promise<Result> {
  try {
    await requireOperator();
    const version = input.version.trim();
    if (!version) return { ok: false, error: '버전 이름을 입력하세요 (예: TER-2026.1).' };
    if (!input.effectiveFrom) return { ok: false, error: '적용 시작일을 입력하세요.' };

    const parsed = parseTaxTableCsv(input.csvText);
    if (parsed.errors.length > 0) {
      return {
        ok: false,
        error: '세율표를 저장하지 않았습니다. 아래를 고쳐 다시 올려 주세요.',
        parseErrors: parsed.errors.slice(0, 20),
      };
    }

    const supabase = await createClient();

    const { data: existing } = await supabase
      .from('tax_tables')
      .select('id')
      .eq('version', version)
      .limit(1);
    if ((existing ?? []).length > 0) {
      return { ok: false, error: `${version} 은 이미 등록되어 있습니다. 다른 버전 이름을 쓰세요.` };
    }

    // Close the version that was in force, so a lookup by date resolves to
    // exactly one schedule.
    const dayBefore = new Date(`${input.effectiveFrom}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await supabase
      .from('tax_tables')
      .update({ effective_to: dayBefore.toISOString().slice(0, 10) })
      .is('effective_to', null)
      .lt('effective_from', input.effectiveFrom);

    const rows = parsed.bands.map((b) => ({
      version,
      method: 'ter',
      category: b.category,
      lower_bound: b.lower_bound,
      upper_bound: b.upper_bound,
      rate: b.rate,
      effective_from: input.effectiveFrom,
    }));

    const { error } = await supabase.from('tax_tables').insert(rows);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'TAX_TABLE_UPLOADED',
      p_target_table: 'tax_tables',
      p_target_id: version,
      p_details: {
        bands: rows.length,
        categories: parsed.categories,
        effective_from: input.effectiveFrom,
      },
    });

    revalidatePath('/policy');
    return { ok: true, bands: rows.length, categories: parsed.categories };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '업로드에 실패했습니다.' };
  }
}

export async function upsertUmkAction(input: {
  region: string;
  amount: number;
  year: number;
}): Promise<Result> {
  try {
    await requireOperator();
    if (!input.region.trim()) return { ok: false, error: '지역을 입력하세요.' };
    // Zero would make the minimum-wage check pass everybody in that region
    // while reporting a clean result, which is worse than having no row.
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { ok: false, error: 'UMK 금액은 0보다 커야 합니다.' };
    }

    const supabase = await createClient();
    const { error } = await supabase.from('umk_rates').upsert(
      {
        region: input.region.trim(),
        amount: input.amount,
        year: input.year,
        effective_from: `${input.year}-01-01`,
      },
      { onConflict: 'region,year' }
    );
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'UMK_UPDATED',
      p_target_table: 'umk_rates',
      p_target_id: `${input.region}|${input.year}`,
      p_details: { amount: input.amount },
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/** Company policy rather than statute: the variance band that sends a payslip
 * to G3, the loan deduction ceiling, and the weekly overtime cap. */
export async function updatePolicyAction(input: {
  varianceThreshold: number;
  maxLoanDeductionRate: number;
  weeklyOtCapHours: number;
}): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    if (input.maxLoanDeductionRate < 0 || input.maxLoanDeductionRate > 100) {
      return { ok: false, error: '대출 공제 상한은 0~100% 사이여야 합니다.' };
    }
    const supabase = await createClient();

    const { error } = await supabase
      .from('payroll_policies')
      .update({
        max_loan_deduction_rate: input.maxLoanDeductionRate,
        weekly_ot_cap_minutes: Math.round(input.weeklyOtCapHours * 60),
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', session.company_id);
    if (error) throw error;

    // The variance band lives on the gate rule, since that is what reads it —
    // but gate_rules is shared reference data and only the operator may write
    // it. RLS filters the update instead of failing it, so a zero-row result is
    // a refusal, not a no-op, and has to be reported as one.
    const { data: ruleTouched, error: ruleError } = await supabase
      .from('gate_rules')
      .update({ threshold: input.varianceThreshold, updated_at: new Date().toISOString() })
      .eq('code', 'G3_NET_VARIANCE')
      .select('code');
    if (ruleError) throw ruleError;
    if ((ruleTouched ?? []).length === 0) {
      return {
        ok: false,
        error:
          '회사 정책은 저장했지만 변동 임계값은 바꾸지 못했습니다. 게이트 규칙은 운영사만 변경할 수 있습니다.',
      };
    }

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_POLICY_UPDATED',
      p_target_table: 'payroll_policies',
      p_target_id: session.company_id,
      p_details: input,
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/**
 * Changes the credit-scoring weights.
 *
 * max_points is derived rather than entered: it is the factor's share of the
 * 550 points above the base, and letting the two be set independently would
 * let the ceiling drift away from the 850 people are shown.
 *
 * Scores already issued do not move. credit_score_details keeps the weight and
 * the points each factor actually contributed, so a decision made last month
 * still explains itself under the rules that applied when it was made.
 */
export async function updateCreditWeightsAction(
  weights: { code: string; weight: number }[]
): Promise<Result> {
  try {
    // Operator-only, because credit_score_factors has no company_id: it is one
    // row set shared by every tenant, so a customer editing it would rescore
    // every other customer's employees.
    const session = await requireOperator();
    const check = validateWeights(weights);
    if (!check.ok) return { ok: false, error: check.error };

    const supabase = await createClient();
    const { data: current } = await supabase
      .from('credit_score_factors')
      .select('code, weight')
      .eq('active', true);
    const before = new Map((current ?? []).map((c) => [c.code as string, Number(c.weight)]));

    const changed: Record<string, string> = {};
    for (const w of weights) {
      if (!before.has(w.code)) return { ok: false, error: `알 수 없는 항목입니다: ${w.code}` };
      if (before.get(w.code) !== w.weight) {
        changed[w.code] = `${before.get(w.code)}% → ${w.weight}%`;
      }
      const { data: touched, error } = await supabase
        .from('credit_score_factors')
        .update({ weight: w.weight, max_points: pointsForWeight(w.weight) })
        .eq('code', w.code)
        .select('code');
      if (error) throw error;
      // RLS filters an UPDATE rather than failing it, so PostgREST answers a
      // blocked write with success and zero rows. Without this the screen says
      // saved, the audit log records a change, and nothing moved.
      if ((touched ?? []).length === 0) {
        return { ok: false, error: `${w.code} 항목을 변경할 권한이 없습니다.` };
      }
    }

    if (Object.keys(changed).length === 0) return { ok: false, error: '변경된 항목이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'CREDIT_WEIGHTS_UPDATED',
      p_target_table: 'credit_score_factors',
      p_target_id: session.company_id,
      p_details: { changed },
    });

    revalidatePath('/policy');
    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}
