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

    // A schedule that starts on or before one already in force cannot simply
    // be loaded: closing only earlier versions would leave two open at once,
    // and the calculation would then read both sets of bands as one schedule
    // with overlapping ranges. Refused rather than guessed, because the right
    // answer — retire the newer one, or pick a different date — is the
    // operator's call and the wrong one withholds the wrong tax.
    const { data: open } = await supabase
      .from('tax_tables')
      .select('version, effective_from')
      .is('effective_to', null)
      .gte('effective_from', input.effectiveFrom)
      .limit(1);
    if ((open ?? []).length > 0) {
      const blocking = open![0];
      return {
        ok: false,
        error: `${blocking.version} 이(가) ${blocking.effective_from}부터 적용 중입니다. 시작일이 그보다 빠른 세율표는 올릴 수 없습니다. 기존 버전을 먼저 종료하세요.`,
      };
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

/**
 * Overtime: multiplier brackets or a flat hourly rate.
 *
 * The brackets themselves are statutory and stay operator-owned. What a
 * company chooses here is which of the two methods applies to it, the divisor
 * behind the hourly rate, and the flat amount when it uses one.
 */
export async function updateOtPolicyAction(input: {
  otMode: 'multiplier' | 'fixed_hourly';
  otHourDivisor: number;
  otFixedHourlyRate: number | null;
}): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    if (!(input.otHourDivisor > 0)) {
      return { ok: false, error: '시급 산식 분모는 0보다 커야 합니다.' };
    }
    if (input.otMode === 'fixed_hourly' && !(Number(input.otFixedHourlyRate) > 0)) {
      return { ok: false, error: '고정 요율 방식에는 시간당 금액이 있어야 합니다.' };
    }
    // 173 = 40h/week × 52 ÷ 12, the figure in Kepmenakertrans 102/2004. A
    // larger divisor makes the hourly rate smaller, so it can only be raised
    // against the employee.
    if (input.otHourDivisor > 173) {
      return {
        ok: false,
        error: '분모가 173을 넘으면 시급이 법정 기준보다 낮아집니다 (Kepmenakertrans 102/2004).',
      };
    }

    const supabase = await createClient();
    const { data: touched, error } = await supabase
      .from('payroll_policies')
      .update({
        ot_mode: input.otMode,
        ot_hour_divisor: input.otHourDivisor,
        // Cleared when switching back, so a stale amount cannot be read as
        // current by anything that looks at the column alone.
        ot_fixed_hourly_rate:
          input.otMode === 'fixed_hourly' ? input.otFixedHourlyRate : null,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', session.company_id)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'OT_POLICY_UPDATED',
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

/** Which grades earn overtime. Managerial grades are usually salaried out of it. */
export async function updatePositionOtAction(
  rows: { id: string; ot_eligible: boolean }[]
): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    const supabase = await createClient();

    let changed = 0;
    for (const r of rows) {
      const { data: touched, error } = await supabase
        .from('positions')
        .update({ ot_eligible: r.ot_eligible, updated_at: new Date().toISOString() })
        .eq('id', r.id)
        .eq('company_id', session.company_id)
        .select('id');
      if (error) throw error;
      changed += (touched ?? []).length;
    }
    if (changed === 0) return { ok: false, error: '변경된 직급이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'POSITION_OT_UPDATED',
      p_target_table: 'positions',
      p_target_id: session.company_id,
      p_details: { changed },
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/**
 * Proration: the company default and per-department overrides.
 *
 * An override of null means "follow the company", not a copy of today's value
 * — a copy stops tracking the company setting the moment somebody changes it.
 */
export async function updateProrationAction(input: {
  companyBasis: 'calendar' | 'fixed_30' | 'working_days';
  departments: { id: string; basis: 'calendar' | 'fixed_30' | 'working_days' | null }[];
}): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    const supabase = await createClient();

    const { data: touched, error } = await supabase
      .from('payroll_policies')
      .update({ proration_basis: input.companyBasis, updated_at: new Date().toISOString() })
      .eq('company_id', session.company_id)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    for (const d of input.departments) {
      const { error: deptError } = await supabase
        .from('departments')
        .update({ proration_basis: d.basis, updated_at: new Date().toISOString() })
        .eq('id', d.id)
        .eq('company_id', session.company_id);
      if (deptError) throw deptError;
    }

    await supabase.rpc('log_audit', {
      p_action: 'PRORATION_POLICY_UPDATED',
      p_target_table: 'payroll_policies',
      p_target_id: session.company_id,
      p_details: {
        company: input.companyBasis,
        overrides: input.departments.filter((d) => d.basis !== null).length,
      },
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

export interface PayComponentInput {
  id?: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  calc_type: 'fixed' | 'rate_of_base' | 'formula' | 'per_attendance';
  amount: number | null;
  formula: string | null;
  taxable: boolean;
  bpjs_base: boolean;
  prorate: boolean;
  recurring: boolean;
  gross_up: boolean;
  borne_by: 'none' | 'employee' | 'employer';
  active: boolean;
}

/**
 * Creates or edits a pay component.
 *
 * Edits in place rather than versioning, but only while the component has
 * never been used: once a run has a line carrying this code, changing its tax
 * or BPJS treatment would rewrite what a closed payslip meant. After that it
 * can only be deactivated, and a replacement created under a new code.
 */
export async function savePayComponentAction(input: PayComponentInput): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    if (!input.code.trim() || !input.name.trim()) {
      return { ok: false, error: '코드와 항목명은 필수입니다.' };
    }
    if (input.calc_type === 'formula' && !input.formula?.trim()) {
      return { ok: false, error: '수식 방식에는 수식이 있어야 합니다.' };
    }
    if (input.calc_type !== 'formula' && !(Number(input.amount) >= 0)) {
      return { ok: false, error: '기준 금액·요율을 입력하세요.' };
    }

    const supabase = await createClient();

    if (input.id) {
      const { data: existing } = await supabase
        .from('pay_components')
        .select('code')
        .eq('id', input.id)
        .maybeSingle();
      if (!existing) return { ok: false, error: '항목을 찾을 수 없습니다.' };

      const { data: used } = await supabase
        .from('payroll_lines')
        .select('id')
        .eq('component_code', existing.code as string)
        .limit(1);
      const inUse = (used ?? []).length > 0;

      // A used component may still be switched off; what it may not do is
      // change what it meant on a payslip that has already been issued.
      const patch: Record<string, unknown> = inUse
        ? { active: input.active, sort_order: undefined, updated_at: new Date().toISOString() }
        : {
            name: input.name,
            kind: input.kind,
            calc_type: input.calc_type,
            amount: input.calc_type === 'formula' ? null : input.amount,
            formula: input.calc_type === 'formula' ? input.formula : null,
            taxable: input.taxable,
            bpjs_base: input.bpjs_base,
            prorate: input.prorate,
            recurring: input.recurring,
            gross_up: input.gross_up,
            borne_by: input.borne_by,
            active: input.active,
            updated_at: new Date().toISOString(),
          };
      delete patch.sort_order;

      const { data: touched, error } = await supabase
        .from('pay_components')
        .update(patch)
        .eq('id', input.id)
        .eq('company_id', session.company_id)
        .select('id');
      if (error) throw error;
      if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

      await supabase.rpc('log_audit', {
        p_action: 'PAY_COMPONENT_UPDATED',
        p_target_table: 'pay_components',
        p_target_id: input.id,
        p_details: { code: existing.code, in_use: inUse },
      });

      revalidatePath('/policy');
      return inUse
        ? {
            ok: true,
            error:
              '이미 계산에 사용된 항목이라 사용 여부만 변경했습니다. 과세·BPJS 설정은 마감된 명세서의 의미를 바꾸므로 수정할 수 없습니다.',
          }
        : { ok: true };
    }

    const { error } = await supabase.from('pay_components').insert({
      company_id: session.company_id,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      kind: input.kind,
      calc_type: input.calc_type,
      amount: input.calc_type === 'formula' ? null : input.amount,
      formula: input.calc_type === 'formula' ? input.formula : null,
      taxable: input.taxable,
      bpjs_base: input.bpjs_base,
      prorate: input.prorate,
      recurring: input.recurring,
      gross_up: input.gross_up,
      borne_by: input.borne_by,
      active: input.active,
    });
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAY_COMPONENT_CREATED',
      p_target_table: 'pay_components',
      p_target_id: session.company_id,
      p_details: { code: input.code, kind: input.kind },
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/** Payment types: whether each runs as its own batch, and on what schedule. */
export async function updatePayrollTypeAction(input: {
  id: string;
  enabled: boolean;
  execution: 'separate' | 'merged';
  frequency: string;
  scheduleRule: string;
}): Promise<Result> {
  try {
    const session = await requireHrAdmin();
    const supabase = await createClient();

    const { data: row } = await supabase
      .from('payroll_type_settings')
      .select('run_type')
      .eq('id', input.id)
      .maybeSingle();
    if (!row) return { ok: false, error: '지급 유형을 찾을 수 없습니다.' };
    if (row.run_type === 'regular' && !input.enabled) {
      return { ok: false, error: '정기급여는 비활성화할 수 없습니다.' };
    }
    // A settlement is triggered by someone leaving, on their own date. Folding
    // it into the monthly batch would hold their final pay until the next run.
    if (row.run_type === 'resignation' && input.execution === 'merged') {
      return { ok: false, error: '퇴직정산은 오프사이클이라 정기급여와 통합할 수 없습니다.' };
    }

    const { data: touched, error } = await supabase
      .from('payroll_type_settings')
      .update({
        enabled: input.enabled,
        execution: input.execution,
        frequency: input.frequency,
        schedule_rule: input.scheduleRule,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.id)
      .eq('company_id', session.company_id)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_TYPE_UPDATED',
      p_target_table: 'payroll_type_settings',
      p_target_id: input.id,
      p_details: { run_type: row.run_type, ...input },
    });

    revalidatePath('/policy');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}
