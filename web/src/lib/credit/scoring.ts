/**
 * Credit scoring, and the eligibility rules that sit on top of it.
 *
 * GajiOne does not lend. This module produces a profile and a recommendation;
 * a licensed lender decides and disburses. Nothing here sets an interest rate,
 * holds a balance, or approves anything — 'auto' below means the referral can
 * go to the lender without a manual review first, not that a loan was granted.
 *
 * Pure, because a score is a claim about a person that they are entitled to
 * have explained. Every point has to be reproducible from the same inputs, and
 * a number nobody can recompute cannot answer "why was I turned down".
 */

export interface ScoreFactor {
  code: string;
  name: string;
  /** Percent, e.g. 30 for 30%. */
  weight: number;
  /** Points this factor contributes at a normalised 100. */
  max_points: number;
  source: string | null;
}

export interface FactorInput {
  code: string;
  /** 0–100. What the raw metric normalises to. */
  normalized: number;
  /** Human-readable basis, e.g. '출근율99.1%·무단결근0회'. */
  raw_metric: string;
}

export interface ScoreDetail {
  factor_code: string;
  factor_name: string;
  weight: number;
  raw_metric: string;
  normalized: number;
  points: number;
}

export interface ScoreResult {
  base_points: number;
  total_score: number;
  max_score: number;
  details: ScoreDetail[];
}

export const BASE_POINTS = 300;
export const MAX_SCORE = 850;
/** The points the weighted factors divide between them. */
export const SCORE_RANGE = MAX_SCORE - BASE_POINTS;

/**
 * Points a factor is worth at its weight.
 *
 * Not rounded: 25% of 550 is 137.5, and rounding each of the four to whole
 * numbers puts the ceiling at 851 instead of 850. The column is numeric for
 * this reason.
 */
export function pointsForWeight(weight: number): number {
  return (SCORE_RANGE * weight) / 100;
}

/**
 * Weights must total exactly 100.
 *
 * Not a warning: a set summing to 90 quietly lowers everyone's ceiling, and a
 * set summing to 110 pushes scores past the maximum people are told about —
 * both while every individual figure on the screen still looks reasonable.
 */
export function validateWeights(weights: { code: string; weight: number }[]): {
  ok: boolean;
  total: number;
  error?: string;
} {
  const total = weights.reduce((s, w) => s + w.weight, 0);
  if (weights.some((w) => !Number.isFinite(w.weight) || w.weight < 0)) {
    return { ok: false, total, error: '가중치는 0 이상이어야 합니다.' };
  }
  // Tolerant to a cent of float noise, not to a percentage point.
  if (Math.abs(total - 100) > 0.001) {
    return { ok: false, total, error: `가중치 합계가 ${total}%입니다. 100%가 되어야 합니다.` };
  }
  return { ok: true, total };
}

/**
 * Base plus the weighted factors.
 *
 * A factor with no input scores zero rather than being skipped: a new joiner
 * with no repayment history has no repayment record to credit, and silently
 * dropping the factor would rescale the remaining ones and quietly inflate
 * their score.
 */
export function computeScore(factors: ScoreFactor[], inputs: FactorInput[]): ScoreResult {
  const byCode = new Map(inputs.map((i) => [i.code, i]));
  const details: ScoreDetail[] = [];

  for (const f of factors) {
    const input = byCode.get(f.code);
    const normalized = input ? clamp(input.normalized, 0, 100) : 0;
    details.push({
      factor_code: f.code,
      factor_name: f.name,
      weight: f.weight,
      raw_metric: input?.raw_metric ?? '자료 없음',
      normalized,
      points: Math.round((normalized / 100) * f.max_points),
    });
  }

  const total = details.reduce((s, d) => s + d.points, BASE_POINTS);
  return {
    base_points: BASE_POINTS,
    // Rounding each factor can push the sum one point over the ceiling; the
    // ceiling is what people are told, so the ceiling wins.
    total_score: Math.min(total, MAX_SCORE),
    max_score: MAX_SCORE,
    details,
  };
}

export type Band = 'auto' | 'manual' | 'declined';

export const BAND_LABELS: Record<Band, string> = {
  auto: '자동심사 통과',
  manual: '수동심사',
  declined: '기준 미달',
};

/** 700+ goes straight to the lender, 600–699 needs a person to look, below 600 does not go. */
export function band(score: number): Band {
  if (score >= 700) return 'auto';
  if (score >= 600) return 'manual';
  return 'declined';
}

export interface LimitInput {
  /** Recent monthly net pay, the basis for both the ceiling and the instalment cap. */
  monthlyNet: number;
  /** Deductions already committed each month to existing mandates. */
  existingMonthly: number;
  /** Percent of net that all loan deductions together may not exceed. */
  maxRatePercent: number;
}

export interface Limits {
  /** Ceiling on the principal: twice monthly net, per the product rules. */
  principalCap: number;
  /** Most that may be deducted per month across every mandate. */
  monthlyCap: number;
  /** What is left of the monthly cap after existing mandates. */
  monthlyAvailable: number;
}

export function limits(input: LimitInput): Limits {
  const monthlyCap = Math.floor((input.monthlyNet * input.maxRatePercent) / 100);
  return {
    principalCap: Math.floor(input.monthlyNet * 2),
    monthlyCap,
    monthlyAvailable: Math.max(0, monthlyCap - input.existingMonthly),
  };
}

export interface ApplicationInput {
  score: number;
  amountRequested: number;
  months: number;
  limitInput: LimitInput;
  /** No consent on file means nothing may be sent to the lender, whatever the score. */
  hasConsent: boolean;
}

export interface Assessment {
  band: Band;
  /** What the screen should do with it, after every rule is applied. */
  outcome: 'auto' | 'manual' | 'declined';
  monthlyInstalment: number;
  /** Instalment as a percentage of net, which is what the 30% rule is about. */
  instalmentRatePercent: number;
  limits: Limits;
  /** Every reason, not just the first — a decision people can act on names all of it. */
  reasons: string[];
}

/**
 * The recommendation.
 *
 * Downgrades only: a rule can move an application from auto to manual, or to
 * declined, never the other way. A score alone must not be able to override
 * the deduction ceiling, which exists so people can still pay rent.
 */
export function assess(input: ApplicationInput): Assessment {
  const lim = limits(input.limitInput);
  const months = Math.max(1, input.months);
  const monthlyInstalment = Math.ceil(input.amountRequested / months);
  const rate =
    input.limitInput.monthlyNet > 0
      ? (monthlyInstalment / input.limitInput.monthlyNet) * 100
      : 0;

  const reasons: string[] = [];
  let outcome: Band = band(input.score);

  if (outcome === 'declined') reasons.push(`신용점수 ${input.score}점 — 600점 미만`);
  else if (outcome === 'manual') reasons.push(`신용점수 ${input.score}점 — 수동심사 구간`);

  if (!input.hasConsent) {
    // Not a credit judgement: without consent there is no lawful basis to send
    // the profile anywhere, so the referral cannot leave the building at all.
    outcome = 'declined';
    reasons.push('정보제공 동의가 없어 금융기관에 전달할 수 없습니다');
  }
  if (input.amountRequested > lim.principalCap) {
    outcome = downgrade(outcome, 'manual');
    reasons.push(`신청금액이 한도(월실수령 2배)를 초과합니다`);
  }
  if (monthlyInstalment > lim.monthlyAvailable) {
    outcome = downgrade(outcome, 'manual');
    reasons.push(
      `월공제 ${rate.toFixed(1)}% — 공제 여력(${input.limitInput.maxRatePercent}% 기준)을 초과합니다`
    );
  }
  if (input.limitInput.monthlyNet <= 0) {
    outcome = 'declined';
    reasons.push('실수령 이력이 없어 한도를 산정할 수 없습니다');
  }

  if (reasons.length === 0) reasons.push('점수·한도·공제여력 기준을 모두 충족');

  return {
    band: band(input.score),
    outcome,
    monthlyInstalment,
    instalmentRatePercent: rate,
    limits: lim,
    reasons,
  };
}

function downgrade(current: Band, to: Band): Band {
  const order: Band[] = ['auto', 'manual', 'declined'];
  return order.indexOf(to) > order.indexOf(current) ? to : current;
}

/**
 * Normalisation of the raw signals into 0–100.
 *
 * Kept here rather than in SQL so the mapping is visible next to the scoring
 * it feeds, and so a change to it is a code change somebody reviews.
 *
 * ⚠️ The curves below are provisional. Where the bands sit — how fast a score
 * should fall for a point of absenteeism, what a year of tenure is worth — is
 * a credit-risk decision, not an engineering one, and needs signing off before
 * anyone is turned down on the strength of it. The mockup's worked example
 * (99.1% attendance → 92/100) implies a steeper curve than these.
 */
export function normalizeAttendance(attendanceRate: number, absences: number): FactorInput {
  const value = clamp(attendanceRate - absences * 5, 0, 100);
  return {
    code: 'attendance',
    normalized: value,
    raw_metric: `출근율${attendanceRate.toFixed(1)}%·무단결근${absences}회`,
  };
}

export function normalizeRepayment(completedLoans: number, lateCount: number): FactorInput {
  // No history is not a bad history, but it is not a good one either: a
  // neutral 60 rather than 0 or 100.
  //
  // Depth counts as well as cleanliness. One repaid loan and no lateness is
  // evidence, but it is thin evidence — scoring it the same as three would
  // let a single small advance max the factor out.
  const value =
    completedLoans === 0 && lateCount === 0
      ? 60
      : 70 + Math.min(completedLoans, 3) * 10 - lateCount * 30;
  return {
    code: 'repayment',
    normalized: clamp(value, 0, 100),
    raw_metric:
      completedLoans === 0 && lateCount === 0
        ? '대출 이력 없음'
        : `기존대출${completedLoans}건 완주·연체${lateCount}회`,
  };
}

export function normalizeTenure(years: number, employmentType: string): FactorInput {
  const permanent = employmentType === 'permanent';
  // Probation is a lending restriction in the product rules, not a low score.
  const probation = employmentType === 'probation';
  const value = probation ? 0 : clamp(years * 18, 0, 90) + (permanent ? 10 : 0);
  return {
    code: 'tenure',
    normalized: clamp(value, 0, 100),
    raw_metric: `근속${years.toFixed(1)}년·${employmentType}`,
  };
}

/**
 * Pay stability from the coefficient of variation of recent net pay. Someone
 * whose take-home swings is not a worse worker, but their capacity to carry a
 * fixed instalment is genuinely less predictable.
 */
export function normalizePayStability(nets: number[]): FactorInput {
  const usable = nets.filter((n) => n > 0);
  if (usable.length < 2) {
    return { code: 'pay_stability', normalized: 50, raw_metric: '급여 이력 부족 (2개월 미만)' };
  }
  const mean = usable.reduce((s, n) => s + n, 0) / usable.length;
  const variance = usable.reduce((s, n) => s + (n - mean) ** 2, 0) / usable.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return {
    code: 'pay_stability',
    normalized: clamp(100 - cv * 400, 0, 100),
    raw_metric: `${usable.length}개월 실수령 변동계수 ${(cv * 100).toFixed(1)}%`,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export const REFERRAL_STATUS_LABELS: Record<string, string> = {
  draft: '심사대기',
  referred: '금융기관 전달',
  approved: '금융기관 승인',
  rejected: '금융기관 거절',
  cancelled: '취소',
  disbursed: '실행완료',
};

export const MANDATE_STATUS_LABELS: Record<string, string> = {
  active: '정상',
  suspended: '유예',
  completed: '완료',
  cancelled: '해지',
};
