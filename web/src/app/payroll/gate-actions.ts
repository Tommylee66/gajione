'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { evaluateG3, canPassG3, type GateItem, type GateRule } from '@/lib/payroll/gates';

const RUN_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];
const EXPLAIN_ROLES = ['line_manager', 'hr_admin', 'operator_admin'];
const DECIDE_ROLES = ['hr_admin', 'operator_admin'];

async function requireRole(roles: string[]) {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface GateActionResult {
  ok: boolean;
  error?: string;
  rulesPassed?: number;
  rulesTotal?: number;
  variances?: number;
}

/**
 * Runs the rules and records both the results and the variance cases.
 *
 * Re-runnable: rule results are replaced, but variance cases that already
 * carry an explanation are left alone. Someone's written judgement must not
 * disappear because the gate was evaluated again.
 */
export async function evaluateGateAction(runId: string): Promise<GateActionResult> {
  try {
    const session = await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: run } = await supabase.from('payroll_runs').select('*').eq('id', runId).maybeSingle();
    if (!run) return { ok: false, error: '차수를 찾을 수 없습니다.' };
    if (!run.batch_hash) return { ok: false, error: '아직 계산되지 않은 차수입니다.' };

    const [itemRes, lineRes, ruleRes, recalcRes, policyRes, umkRes, empRes] = await Promise.all([
      supabase.from('payroll_items').select('*').eq('run_id', runId),
      supabase
        .from('payroll_lines')
        .select('payroll_item_id, kind, amount, component_code')
        .eq('company_id', session.company_id),
      supabase.from('gate_rules').select('*').eq('active', true),
      supabase.from('payroll_recalcs').select('pass_no, batch_hash').eq('run_id', runId),
      supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
      supabase.from('umk_rates').select('region, amount'),
      supabase.from('employees').select('id, umk_region'),
    ]);

    const items = itemRes.data ?? [];
    if (items.length === 0) return { ok: false, error: '계산 결과가 없습니다.' };

    // Previous regular run of the same company, for the variance comparison.
    const { data: prevRun } = await supabase
      .from('payroll_runs')
      .select('id')
      .eq('run_type', 'regular')
      .lt('period', run.period as string)
      .order('period', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevNetByEmployee = new Map<string, number>();
    if (prevRun) {
      const { data: prevItems } = await supabase
        .from('payroll_items')
        .select('employee_id, net')
        .eq('run_id', prevRun.id);
      for (const p of prevItems ?? []) {
        prevNetByEmployee.set(p.employee_id as string, Number(p.net));
      }
    }

    // Written back onto the item so a payslip carries its own comparison
    // basis, rather than G3 having to reach across runs every time it looks.
    for (const [employeeId, net] of prevNetByEmployee) {
      await supabase
        .from('payroll_items')
        .update({ prev_net: net, updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .eq('employee_id', employeeId);
    }

    const lineTotals = new Map<string, { earning: number; deduction: number; loan: number }>();
    for (const l of lineRes.data ?? []) {
      const key = l.payroll_item_id as string;
      const entry = lineTotals.get(key) ?? { earning: 0, deduction: 0, loan: 0 };
      const amount = Number(l.amount);
      if (l.kind === 'earning') entry.earning += amount;
      else {
        entry.deduction += amount;
        if (l.component_code === 'LOAN') entry.loan += amount;
      }
      lineTotals.set(key, entry);
    }

    const umkRegionByEmployee = new Map(
      (empRes.data ?? []).map((e) => [e.id as string, e.umk_region as string | null])
    );

    const gateItems: GateItem[] = items.map((i) => {
      const totals = lineTotals.get(i.id as string) ?? { earning: 0, deduction: 0, loan: 0 };
      return {
        employee_id: i.employee_id as string,
        employee_no: i.employee_no as string,
        employee_name: i.employee_name as string,
        department_id: (i.department_id as string | null) ?? null,
        base_salary: Number(i.base_salary),
        gross: Number(i.gross),
        deduction_total: Number(i.deduction_total),
        net: Number(i.net),
        prev_net: prevNetByEmployee.get(i.employee_id as string) ?? null,
        umk_region: umkRegionByEmployee.get(i.employee_id as string) ?? null,
        line_sum_earning: totals.earning,
        line_sum_deduction: totals.deduction,
        loan_deduction: totals.loan,
      };
    });

    const recalcs = recalcRes.data ?? [];
    const { results, variances } = evaluateG3({
      items: gateItems,
      rules: (ruleRes.data ?? []) as GateRule[],
      recalcHashesAgree: recalcs.length === 2 && recalcs[0].batch_hash === recalcs[1].batch_hash,
      taxVersion: (run.tax_table_version as string | null) ?? null,
      bpjsVersion: (run.bpjs_rate_version as string | null) ?? null,
      maxLoanDeductionRate: Number(policyRes.data?.max_loan_deduction_rate ?? 30),
      umkByRegion: new Map((umkRes.data ?? []).map((u) => [u.region as string, Number(u.amount)])),
    });

    await supabase.from('gate_results').delete().eq('run_id', runId);
    await supabase.from('gate_results').insert(
      results.map((r) => ({
        company_id: session.company_id,
        run_id: runId,
        rule_code: r.code,
        gate: 'G3',
        passed: r.passed,
        severity: r.severity,
        detail: { message: r.detail, offenders: r.offenders },
      }))
    );

    const { data: existingCases } = await supabase
      .from('variance_cases')
      .select('employee_id, status')
      .eq('run_id', runId);
    const keep = new Set(
      (existingCases ?? []).filter((c) => c.status !== 'pending').map((c) => c.employee_id as string)
    );

    await supabase.from('variance_cases').delete().eq('run_id', runId).eq('status', 'pending');

    const fresh = variances
      .filter((v) => !keep.has(v.employee_id))
      .map((v) => ({
        company_id: session.company_id,
        run_id: runId,
        employee_id: v.employee_id,
        prev_net: v.prev_net,
        curr_net: v.curr_net,
        change_rate: v.change_rate,
        status: 'pending',
      }));
    if (fresh.length > 0) {
      const { error } = await supabase.from('variance_cases').insert(fresh);
      if (error) throw error;
    }

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_G3_EVALUATED',
      p_target_table: 'payroll_runs',
      p_target_id: runId,
      p_details: {
        rules_passed: results.filter((r) => r.passed).length,
        rules_total: results.length,
        variances: variances.length,
      },
    });

    revalidatePath(`/payroll/${runId}`);
    return {
      ok: true,
      rulesPassed: results.filter((r) => r.passed).length,
      rulesTotal: results.length,
      variances: variances.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '평가에 실패했습니다.' };
  }
}

/** Step one: the line manager explains what happened. */
export async function submitExplanationAction(
  caseId: string,
  comment: string
): Promise<GateActionResult> {
  try {
    const session = await requireRole(EXPLAIN_ROLES);
    if (!comment.trim()) return { ok: false, error: '소명 내용을 입력하세요.' };

    const supabase = await createClient();
    const { error } = await supabase
      .from('variance_cases')
      .update({
        line_manager_id: session.id,
        line_comment: comment,
        line_submitted_at: new Date().toISOString(),
        status: 'explained',
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);
    if (error) throw error;

    revalidatePath('/payroll');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * Step two: HR decides.
 *
 * A separate actor and timestamp from the explanation, because "who let this
 * through" is the question asked months later and one approver column cannot
 * answer it. Returning a case puts it back to the line manager rather than
 * rejecting it outright.
 */
export async function decideVarianceAction(
  caseId: string,
  decision: 'approved' | 'rejected' | 'returned',
  comment: string
): Promise<GateActionResult> {
  try {
    const session = await requireRole(DECIDE_ROLES);
    const supabase = await createClient();

    const { data: existing } = await supabase
      .from('variance_cases')
      .select('status, line_submitted_at')
      .eq('id', caseId)
      .maybeSingle();
    if (!existing) return { ok: false, error: '소명 건을 찾을 수 없습니다.' };
    if (!existing.line_submitted_at) {
      return { ok: false, error: '라인장 소명이 아직 없습니다. 1차 소명 후 승인할 수 있습니다.' };
    }

    const { error } = await supabase
      .from('variance_cases')
      .update({
        hr_approver_id: session.id,
        hr_decision: decision,
        hr_comment: comment,
        hr_decided_at: new Date().toISOString(),
        status: decision === 'returned' ? 'pending' : decision,
        // A returned case goes back for a fresh explanation.
        ...(decision === 'returned' ? { line_submitted_at: null } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_VARIANCE_DECIDED',
      p_target_table: 'variance_cases',
      p_target_id: caseId,
      p_details: { decision, comment },
    });

    revalidatePath('/payroll');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

export async function passG3Action(runId: string): Promise<GateActionResult> {
  try {
    await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const [resultRes, caseRes] = await Promise.all([
      supabase.from('gate_results').select('*').eq('run_id', runId),
      supabase.from('variance_cases').select('status').eq('run_id', runId),
    ]);

    const results = (resultRes.data ?? []).map((r) => ({
      code: r.rule_code as string,
      name: ((r.detail as { message?: string })?.message ?? r.rule_code) as string,
      severity: r.severity as 'blocking' | 'warning',
      passed: r.passed as boolean,
      detail: '',
      offenders: [],
      legal_basis: null,
    }));
    const cases = caseRes.data ?? [];
    const check = canPassG3(
      results,
      cases.filter((c) => c.status === 'pending' || c.status === 'explained').length,
      cases.filter((c) => c.status === 'rejected').length
    );

    if (!check.ok) {
      return { ok: false, error: `G3를 통과할 수 없습니다: ${check.reasons.join(', ')}` };
    }

    const { error } = await supabase
      .from('payroll_runs')
      .update({ status: 'g3_passed', updated_at: new Date().toISOString() })
      .eq('id', runId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_G3_PASSED',
      p_target_table: 'payroll_runs',
      p_target_id: runId,
      p_details: {},
    });

    revalidatePath(`/payroll/${runId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}
