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

    // Frozen here, not looked up by the partner. The lender gets the profile
    // GajiOne computed and nothing else: no NIK, no NPWP, no payslip, no
    // employee row. Consent scope decides how much of even that travels.
    const profile = await buildProfileSnapshot(
      supabase,
      ref.employee_id as string,
      consent.scope as string,
      check.scoreId
    );

    const { error } = await supabase
      .from('loan_referrals')
      .update({
        status: 'referred',
        referred_at: new Date().toISOString(),
        consent_id: consent.id as string,
        lender_decision: 'pending',
        score_snapshot: check.score,
        credit_score_id: check.scoreId,
        profile_snapshot: profile,
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
 * The summary the partner portal shows.
 *
 * Built from what has already been computed rather than from the employee
 * record, and cut to the consent scope: 'score_only' really does mean the
 * score, with tenure and attendance withheld. A partner who needs more has to
 * be given a broader consent, not a broader query.
 */
async function buildProfileSnapshot(
  supabase: Awaited<ReturnType<typeof createClient>>,
  employeeId: string,
  scope: string,
  scoreId: string | null
): Promise<Record<string, unknown>> {
  const [empRes, companyRes, detailRes] = await Promise.all([
    supabase.from('employees').select('employee_no, join_date, employment_type').eq('id', employeeId).maybeSingle(),
    supabase.from('companies').select('name').maybeSingle(),
    scoreId
      ? supabase.from('credit_score_details').select('factor_code, raw_metric, normalized').eq('credit_score_id', scoreId)
      : Promise.resolve({ data: [] as { factor_code: string; raw_metric: string; normalized: number }[] }),
  ]);

  const base: Record<string, unknown> = {
    employee_no: empRes.data?.employee_no ?? null,
    employer: companyRes.data?.name ?? null,
    scope,
  };
  if (scope === 'score_only') return base;

  const join = empRes.data?.join_date as string | null;
  const years = join ? (Date.now() - new Date(join).getTime()) / (365.25 * 86_400_000) : null;
  const detail = (code: string) =>
    (detailRes.data ?? []).find((d) => d.factor_code === code);

  return {
    ...base,
    tenure_years: years === null ? null : Number(years.toFixed(1)),
    employment_type: empRes.data?.employment_type ?? null,
    // The raw metrics the score was built from — the same strings the employee
    // sees on their own breakdown, so the two cannot disagree.
    attendance: detail('attendance')?.raw_metric ?? null,
    repayment: detail('repayment')?.raw_metric ?? null,
    pay_stability: detail('pay_stability')?.raw_metric ?? null,
  };
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

    // The deduction is the lender's instalment, not the principal divided by
    // the months. Those differ by the interest, and taking the second would
    // under-collect every month and leave the loan unpaid at the end of a
    // schedule that says it is finished.
    //
    // Under equal principal the first instalment is the largest, which is the
    // one the ceiling has to clear and the one worth showing on the mandate.
    const { data: offer } = await supabase
      .from('loan_offers')
      .select('months, monthly_amount, first_month_amount, repayment_method')
      .eq('referral_id', referralId)
      .eq('status', 'disbursed')
      .order('disbursed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const monthlyAmount = offer
      ? Number(offer.first_month_amount ?? offer.monthly_amount)
      : check.monthlyInstalment;
    if (monthlyAmount > check.monthlyAvailable) {
      return {
        ok: false,
        error: `월공제 ${Math.round(monthlyAmount).toLocaleString('id-ID')}가 공제 여력 ${Math.round(check.monthlyAvailable).toLocaleString('id-ID')}을 초과합니다.`,
      };
    }

    const months = offer ? Number(offer.months) : Number(ref.months ?? 0) || 1;
    // The borrower's name, recorded here and nowhere earlier. From this point
    // there is a credit agreement and the lender is party to it; before it,
    // they were assessing a staff number.
    const { data: borrower } = await supabase
      .from('employees')
      .select('full_name')
      .eq('id', ref.employee_id as string)
      .maybeSingle();

    const { error } = await supabase.from('deduction_mandates').insert({
      borrower_name: (borrower?.full_name as string | null) ?? null,
      company_id: session.company_id,
      employee_id: ref.employee_id as string,
      lender_id: ref.lender_id as string,
      referral_id: referralId,
      lender_ref_no: (ref.lender_ref_no as string | null) ?? null,
      monthly_amount: monthlyAmount,
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
      p_details: {
        monthly: monthlyAmount,
        months,
        start_period: startPeriod,
        // Says which figure was used, because the two differ by the interest.
        source: offer ? 'lender_offer' : 'requested_amount',
      },
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

/**
 * Relays the employee's answer to an offer.
 *
 * The employee app does not exist yet, so HR records what the worker said —
 * which is honest about who is speaking and leaves a name against the answer.
 * When the app arrives this moves to the employee and this action goes.
 */
export async function respondToOfferAction(
  offerId: string,
  response: 'accepted' | 'declined',
  reason: string
): Promise<LoanActionResult> {
  try {
    const session = await requireRole(HR_ROLES);
    const supabase = await createClient();

    const { data: offer } = await supabase
      .from('loan_offers')
      .select('*')
      .eq('id', offerId)
      .maybeSingle();
    if (!offer) return { ok: false, error: '오퍼를 찾을 수 없습니다.' };
    if (offer.status !== 'sent') {
      return { ok: false, error: '발송 상태의 오퍼에만 응답할 수 있습니다.' };
    }
    // Checked against the clock rather than trusted to a background job: an
    // expired offer accepted on the screen is an agreement on terms the lender
    // has already stopped standing behind.
    if (Date.parse(offer.expires_at as string) <= Date.now()) {
      return { ok: false, error: '유효기간이 지난 오퍼입니다. 금융기관에 재발송을 요청하세요.' };
    }

    if (response === 'accepted') {
      // The ceiling is checked again here, against the instalment the offer
      // actually carries — which under equal-principal is the first month's,
      // the largest. The assessment before referral used the requested amount
      // divided by months, and the lender may have offered different terms.
      const [policyRes, itemRes, mandateRes] = await Promise.all([
        supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
        supabase
          .from('payroll_items')
          .select('net')
          .eq('employee_id', (await referralOf(supabase, offer.referral_id as string)) ?? '')
          .order('created_at', { ascending: false })
          .limit(3),
        supabase
          .from('deduction_mandates')
          .select('monthly_amount')
          .eq('employee_id', (await referralOf(supabase, offer.referral_id as string)) ?? '')
          .eq('status', 'active'),
      ]);
      const nets = (itemRes.data ?? []).map((i) => Number(i.net));
      const monthlyNet = nets.length > 0 ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
      const committed = (mandateRes.data ?? []).reduce((s, m) => s + Number(m.monthly_amount), 0);
      const maxRate = Number(policyRes.data?.max_loan_deduction_rate ?? 30);
      const available = Math.max(0, Math.floor((monthlyNet * maxRate) / 100) - committed);
      const instalment = Number(offer.first_month_amount ?? offer.monthly_amount);
      if (monthlyNet > 0 && instalment > available) {
        return {
          ok: false,
          error: `오퍼의 월 상환액 ${instalment.toLocaleString('id-ID')}이 공제 여력 ${available.toLocaleString('id-ID')}을 넘습니다. 조건 조정을 요청하세요.`,
        };
      }
    }

    const now = new Date().toISOString();
    const { data: touched, error } = await supabase
      .from('loan_offers')
      .update({
        status: response,
        responded_at: now,
        decline_reason: response === 'declined' ? reason : null,
        updated_at: now,
      })
      .eq('id', offerId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    if (response === 'declined') {
      await supabase
        .from('loan_referrals')
        .update({ status: 'cancelled', updated_at: now })
        .eq('id', offer.referral_id as string);
    }

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_OFFER_RESPONSE_RELAYED',
      p_target_table: 'loan_offers',
      p_target_id: offerId,
      p_details: { response, reason: reason || null, relayed_by: session.id },
    });

    revalidatePath('/loans');
    revalidatePath('/partner');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

async function referralOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  referralId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('loan_referrals')
    .select('employee_id')
    .eq('id', referralId)
    .maybeSingle();
  return (data?.employee_id as string | null) ?? null;
}
