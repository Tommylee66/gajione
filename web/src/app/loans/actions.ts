'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  assess,
  computeScore,
  normalizeAttendance,
  normalizePayStability,
  normalizeRepayment,
  normalizeTenure,
  type FactorInput,
  type ScoreFactor,
} from '@/lib/credit/scoring';
import { withDefaults, type Curve } from '@/lib/credit/curves';

const HR_ROLES = ['hr_admin', 'operator_admin'];

async function requireRole(roles: string[]) {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface LoanActionResult {
  ok: boolean;
  error?: string;
  scored?: number;
  /** Set when the refusal is "a person must look at this", not "no". */
  needsReview?: boolean;
  reasons?: string[];
}

/**
 * Scores every active employee from a closed run.
 *
 * Takes a run rather than "now" because the score has to be reproducible: a
 * lender reading a profile must see the same number tomorrow, and scoring off
 * an open run would move it under them while they were looking.
 */
export async function scoreEmployeesAction(runId: string): Promise<LoanActionResult> {
  try {
    const session = await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { data: run } = await supabase
      .from('payroll_runs')
      .select('id, period, status')
      .eq('id', runId)
      .maybeSingle();
    if (!run) return { ok: false, error: '차수를 찾을 수 없습니다.' };
    if (run.status !== 'locked') {
      return { ok: false, error: '마감된 차수의 확정 데이터로만 점수를 산출할 수 있습니다.' };
    }

    const [factorRes, empRes, itemRes, anomalyRes, mirrorRes] = await Promise.all([
      supabase.from('credit_score_factors').select('*').eq('active', true).order('weight', { ascending: false }),
      supabase.from('employees').select('id, employee_no, full_name, join_date, employment_type').eq('is_active', true),
      supabase.from('payroll_items').select('employee_id, net, work_days, run_id'),
      supabase.from('attendance_anomalies').select('employee_id, anomaly_type').eq('status', 'open'),
      supabase.from('loan_mirrors').select('employee_id, paid_installments, total_installments, is_overdue'),
    ]);

    const factors = (factorRes.data ?? []) as unknown as ScoreFactor[];
    if (factors.length === 0) return { ok: false, error: '신용점수 항목이 설정되어 있지 않습니다.' };

    // The curves come from the same rows as the weights. Read here rather than
    // defaulted in the scoring functions, so a curve set on the policy screen
    // is the curve the score is actually built from.
    const curves = new Map<string, Curve>(
      (factorRes.data ?? []).map((f) => [
        f.code as string,
        withDefaults(f.code as string, (f as { curve?: unknown }).curve),
      ])
    );
    const curveOf = (code: string) => curves.get(code) ?? withDefaults(code, null);
    const employees = empRes.data ?? [];
    if (employees.length === 0) return { ok: false, error: '재직 중인 직원이 없습니다.' };

    // Net history per employee, newest first — the pay-stability input.
    const netsByEmployee = new Map<string, number[]>();
    for (const i of itemRes.data ?? []) {
      const key = i.employee_id as string;
      const list = netsByEmployee.get(key) ?? [];
      list.push(Number(i.net));
      netsByEmployee.set(key, list);
    }

    const absencesByEmployee = new Map<string, number>();
    for (const a of anomalyRes.data ?? []) {
      const key = a.employee_id as string;
      absencesByEmployee.set(key, (absencesByEmployee.get(key) ?? 0) + 1);
    }

    const historyByEmployee = new Map<string, { completed: number; late: number }>();
    for (const m of mirrorRes.data ?? []) {
      const key = m.employee_id as string;
      const h = historyByEmployee.get(key) ?? { completed: 0, late: 0 };
      if ((m.paid_installments ?? 0) >= (m.total_installments ?? Infinity)) h.completed += 1;
      if (m.is_overdue) h.late += 1;
      historyByEmployee.set(key, h);
    }

    const today = new Date();
    const scoreRows: Record<string, unknown>[] = [];
    const detailsByEmployee = new Map<string, ReturnType<typeof computeScore>>();

    for (const e of employees) {
      const id = e.id as string;
      const nets = netsByEmployee.get(id) ?? [];
      const absences = absencesByEmployee.get(id) ?? 0;
      const history = historyByEmployee.get(id) ?? { completed: 0, late: 0 };
      const joinDate = e.join_date as string | null;
      const years = joinDate
        ? (today.getTime() - new Date(joinDate).getTime()) / (365.25 * 86_400_000)
        : 0;

      // Attendance rate from the run's own work days is the closest thing to
      // the mockup's figure that the data actually supports; a device-level
      // attendance percentage does not exist yet.
      const workDays = (itemRes.data ?? []).find(
        (i) => i.employee_id === id && i.run_id === runId
      )?.work_days;
      const rate = workDays ? Math.min(100, (Number(workDays) / 22) * 100) : 0;

      const inputs: FactorInput[] = [
        normalizeAttendance(rate, absences, curveOf('attendance')),
        normalizeRepayment(history.completed, history.late, curveOf('repayment')),
        normalizeTenure(years, (e.employment_type as string) ?? 'contract', curveOf('tenure')),
        normalizePayStability(nets, curveOf('pay_stability')),
      ];
      const result = computeScore(factors, inputs);
      detailsByEmployee.set(id, result);
      scoreRows.push({
        company_id: session.company_id,
        employee_id: id,
        base_points: result.base_points,
        total_score: result.total_score,
        max_score: result.max_score,
        run_id: runId,
      });
    }

    const { data: inserted, error } = await supabase
      .from('credit_scores')
      .insert(scoreRows)
      .select('id, employee_id');
    if (error) throw error;

    // The breakdown is written alongside, because a total on its own cannot
    // answer "why was I turned down" — and a later weight change must not be
    // able to rewrite the basis of a decision already made.
    const detailRows = (inserted ?? []).flatMap((s) => {
      const result = detailsByEmployee.get(s.employee_id as string);
      if (!result) return [];
      return result.details.map((d) => ({
        company_id: session.company_id,
        credit_score_id: s.id as string,
        factor_code: d.factor_code,
        factor_name: d.factor_name,
        weight: d.weight,
        raw_metric: d.raw_metric,
        normalized: d.normalized,
        points: d.points,
      }));
    });
    if (detailRows.length > 0) {
      const { error: detailError } = await supabase.from('credit_score_details').insert(detailRows);
      if (detailError) throw detailError;
    }

    await supabase.rpc('log_audit', {
      p_action: 'CREDIT_SCORES_COMPUTED',
      p_target_table: 'credit_scores',
      p_target_id: runId,
      p_details: { period: run.period, employees: scoreRows.length },
    });

    revalidatePath('/loans');
    return { ok: true, scored: scoreRows.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '산출에 실패했습니다.' };
  }
}

/**
 * Records the employee's consent to share their profile with one lender.
 *
 * Its own record with a scope and a revocation column, not a flag on the
 * employee: "my score" and "my payslip" are different permissions, and consent
 * that cannot be withdrawn is not consent. UU PDP art. 20.
 */
export async function grantConsentAction(
  employeeId: string,
  lenderId: string,
  scope: 'score_only' | 'score_and_tenure' | 'full_payroll',
  evidenceRef: string
): Promise<LoanActionResult> {
  try {
    const session = await requireRole(HR_ROLES);
    if (!evidenceRef.trim()) {
      return { ok: false, error: '동의 근거(서명 양식·앱 동의 기록)를 남겨야 합니다.' };
    }
    const supabase = await createClient();

    const { error } = await supabase.from('data_sharing_consents').insert({
      company_id: session.company_id,
      employee_id: employeeId,
      lender_id: lenderId,
      scope,
      evidence_ref: evidenceRef,
    });
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'CONSENT_GRANTED',
      p_target_table: 'data_sharing_consents',
      p_target_id: employeeId,
      p_details: { lender_id: lenderId, scope },
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

export async function revokeConsentAction(consentId: string): Promise<LoanActionResult> {
  try {
    await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { error } = await supabase
      .from('data_sharing_consents')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', consentId)
      .is('revoked_at', null);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'CONSENT_REVOKED',
      p_target_table: 'data_sharing_consents',
      p_target_id: consentId,
      p_details: {},
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * Sends a referral to the lender.
 *
 * Refuses without a live consent, and refuses what the rules put out of reach.
 * This is the only place an employee's profile leaves the company, so the
 * check is here rather than on the screen that renders the button.
 */
export async function referAction(
  referralId: string,
  overrideNote = ''
): Promise<LoanActionResult> {
  try {
    await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('*')
      .eq('id', referralId)
      .maybeSingle();
    if (!ref) return { ok: false, error: '신청 건을 찾을 수 없습니다.' };
    if (ref.status !== 'draft') return { ok: false, error: '이미 전달된 신청입니다.' };

    const { data: consent } = await supabase
      .from('data_sharing_consents')
      .select('id, scope')
      .eq('employee_id', ref.employee_id as string)
      .eq('lender_id', ref.lender_id as string)
      .is('revoked_at', null)
      .order('granted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!consent) {
      return { ok: false, error: '유효한 정보제공 동의가 없어 전달할 수 없습니다.' };
    }

    const check = await assessReferral(supabase, ref);
    if (check.outcome === 'declined') {
      return { ok: false, error: `전달할 수 없습니다: ${check.reasons.join(' · ')}` };
    }
    // 'manual' has to mean a person actually looked. Without this the label
    // is decoration and an application at 91% of net walks past it.
    if (check.outcome === 'manual' && !overrideNote.trim()) {
      return {
        ok: false,
        error: `수동심사 대상입니다. 검토 사유를 입력해야 전달할 수 있습니다 — ${check.reasons.join(' · ')}`,
        needsReview: true,
        reasons: check.reasons,
      };
    }

    const { error } = await supabase
      .from('loan_referrals')
      .update({
        status: 'referred',
        referred_at: new Date().toISOString(),
        consent_id: consent.id as string,
        lender_decision: 'pending',
        score_snapshot: check.score,
        credit_score_id: check.scoreId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', referralId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_REFERRED',
      p_target_table: 'loan_referrals',
      p_target_id: referralId,
      p_details: {
        score: check.score,
        outcome: check.outcome,
        scope: consent.scope,
        // Who overrode what, kept because "why did this one go through" is the
        // question asked after a default, not before.
        review_note: overrideNote.trim() || null,
        review_reasons: check.outcome === 'manual' ? check.reasons : null,
      },
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '전달에 실패했습니다.' };
  }
}

/**
 * Records what the lender decided.
 *
 * Recorded, not made: the decision, its reference number and any decline
 * reason come from the lender. GajiOne taking this decision would make it the
 * lender in substance whatever the contract says, and lending without an OJK
 * licence is a criminal matter.
 */
export async function recordLenderDecisionAction(
  referralId: string,
  decision: 'approved' | 'rejected',
  lenderRefNo: string,
  note: string
): Promise<LoanActionResult> {
  try {
    await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('status')
      .eq('id', referralId)
      .maybeSingle();
    if (!ref) return { ok: false, error: '신청 건을 찾을 수 없습니다.' };
    if (ref.status !== 'referred') {
      return { ok: false, error: '금융기관에 전달된 건만 결과를 기록할 수 있습니다.' };
    }
    if (decision === 'approved' && !lenderRefNo.trim()) {
      return { ok: false, error: '금융기관 참조번호가 있어야 합니다.' };
    }

    const { error } = await supabase
      .from('loan_referrals')
      .update({
        status: decision,
        lender_decision: decision,
        lender_ref_no: lenderRefNo.trim() || null,
        decline_reason: decision === 'rejected' ? note : null,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', referralId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'LENDER_DECISION_RECORDED',
      p_target_table: 'loan_referrals',
      p_target_id: referralId,
      p_details: { decision, lender_ref_no: lenderRefNo },
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '기록에 실패했습니다.' };
  }
}

/**
 * Creates the standing deduction instruction after the lender approved.
 *
 * Checked against the ceiling once more here: the assessment ran before the
 * lender looked, and someone's other mandates may have changed in between.
 */
export async function createMandateAction(
  referralId: string,
  startPeriod: string
): Promise<LoanActionResult> {
  try {
    const session = await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('*')
      .eq('id', referralId)
      .maybeSingle();
    if (!ref) return { ok: false, error: '신청 건을 찾을 수 없습니다.' };
    // Checked first: creating the mandate moves the referral to 'disbursed',
    // so a status check here would answer a second attempt with the wrong
    // reason.
    const { data: existing } = await supabase
      .from('deduction_mandates')
      .select('id')
      .eq('referral_id', referralId)
      .limit(1);
    if ((existing ?? []).length > 0) return { ok: false, error: '이미 등록된 공제입니다.' };

    if (ref.status !== 'approved') {
      return { ok: false, error: '금융기관이 승인한 건만 공제를 등록할 수 있습니다.' };
    }
    if (!/^\d{4}-\d{2}$/.test(startPeriod)) {
      return { ok: false, error: '시작 차수는 YYYY-MM 형식이어야 합니다.' };
    }

    const check = await assessReferral(supabase, ref);
    if (check.outcome === 'declined') {
      return { ok: false, error: `공제를 등록할 수 없습니다: ${check.reasons.join(' · ')}` };
    }
    if (check.monthlyInstalment > check.monthlyAvailable) {
      return {
        ok: false,
        error: `월공제 ${Math.round(check.monthlyInstalment).toLocaleString('id-ID')}가 공제 여력을 초과합니다.`,
      };
    }

    const months = Number(ref.months ?? 0) || 1;
    const { error } = await supabase.from('deduction_mandates').insert({
      company_id: session.company_id,
      employee_id: ref.employee_id as string,
      lender_id: ref.lender_id as string,
      referral_id: referralId,
      lender_ref_no: (ref.lender_ref_no as string | null) ?? null,
      monthly_amount: check.monthlyInstalment,
      total_installments: months,
      start_period: startPeriod,
      max_rate: check.maxRatePercent,
      status: 'active',
    });
    if (error) throw error;

    await supabase
      .from('loan_referrals')
      .update({ status: 'disbursed', updated_at: new Date().toISOString() })
      .eq('id', referralId);

    await supabase.rpc('log_audit', {
      p_action: 'DEDUCTION_MANDATE_CREATED',
      p_target_table: 'deduction_mandates',
      p_target_id: referralId,
      p_details: { monthly: check.monthlyInstalment, months, start_period: startPeriod },
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '등록에 실패했습니다.' };
  }
}

export async function setMandateStatusAction(
  mandateId: string,
  status: 'active' | 'suspended' | 'cancelled'
): Promise<LoanActionResult> {
  try {
    await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { error } = await supabase
      .from('deduction_mandates')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', mandateId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'DEDUCTION_MANDATE_STATUS_CHANGED',
      p_target_table: 'deduction_mandates',
      p_target_id: mandateId,
      p_details: { status },
    });

    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Shared by refer and mandate creation so the two cannot drift apart. */
async function assessReferral(supabase: Supabase, ref: Record<string, unknown>) {
  const employeeId = ref.employee_id as string;

  const [scoreRes, policyRes, itemRes, mandateRes] = await Promise.all([
    supabase
      .from('credit_scores')
      .select('id, total_score')
      .eq('employee_id', employeeId)
      .order('scored_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
    supabase
      .from('payroll_items')
      .select('net, created_at')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(3),
    supabase
      .from('deduction_mandates')
      .select('monthly_amount')
      .eq('employee_id', employeeId)
      .eq('status', 'active'),
  ]);

  const nets = (itemRes.data ?? []).map((i) => Number(i.net));
  const monthlyNet = nets.length > 0 ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
  const existingMonthly = (mandateRes.data ?? []).reduce(
    (s, m) => s + Number(m.monthly_amount),
    0
  );
  const maxRatePercent = Number(policyRes.data?.max_loan_deduction_rate ?? 30);

  const result = assess({
    score: Number(scoreRes.data?.total_score ?? 0),
    amountRequested: Number(ref.amount_requested),
    months: Number(ref.months ?? 1),
    limitInput: { monthlyNet, existingMonthly, maxRatePercent },
    hasConsent: true, // Checked separately against the live consent record.
  });

  return {
    ...result,
    score: Number(scoreRes.data?.total_score ?? 0),
    scoreId: (scoreRes.data?.id as string | undefined) ?? null,
    monthlyAvailable: result.limits.monthlyAvailable,
    maxRatePercent,
  };
}
