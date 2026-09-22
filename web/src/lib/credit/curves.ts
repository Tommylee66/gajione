/**
 * The scoring curves, and what may be set on each.
 *
 * Declared here so the screen, the validation and the scoring all read one
 * definition. A field the form offers but the scorer ignores, or a value the
 * scorer honours but nothing validates, is how a credit model quietly starts
 * behaving differently from the way it is documented.
 *
 * Every parameter is a credit-risk decision. The defaults are the values the
 * code carried before this was configurable — a starting point, not a
 * recommendation.
 */

export interface CurveField {
  key: string;
  label: string;
  /** What the number does, in the terms the risk owner thinks in. */
  help: string;
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
}

export const CURVE_FIELDS: Record<string, CurveField[]> = {
  attendance: [
    {
      key: 'zero_at_percent',
      label: '0점 기준 출근율',
      help: '이 출근율에서 0점, 100%에서 100점이 되도록 직선으로 환산합니다. 0이면 출근율이 곧 점수입니다.',
      type: 'number',
      min: 0,
      max: 99,
      step: 1,
    },
    {
      key: 'absence_penalty',
      label: '무단결근 1회당 감점',
      help: '환산 점수에서 결근 횟수만큼 차감합니다.',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
  ],
  repayment: [
    {
      key: 'no_history',
      label: '이력 없음 점수',
      help: '대출을 받아본 적이 없는 사람의 점수. 나쁜 이력은 아니지만 좋은 이력도 아니라는 판단입니다.',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'base',
      label: '이력 있음 기본점수',
      help: '완주 1건 이상이면 여기서 시작해 완주 건수만큼 더하고 연체만큼 뺍니다.',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'per_completed',
      label: '완주 1건당 가점',
      help: '',
      type: 'number',
      min: 0,
      max: 50,
      step: 1,
    },
    {
      key: 'max_completed',
      label: '가점 인정 완주 건수 상한',
      help: '이 건수를 넘는 완주는 더 가산하지 않습니다.',
      type: 'number',
      min: 1,
      max: 20,
      step: 1,
    },
    {
      key: 'late_penalty',
      label: '연체 1회당 감점',
      help: '',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
  ],
  tenure: [
    {
      key: 'per_year',
      label: '근속 1년당 점수',
      help: '',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'years_cap',
      label: '근속 점수 상한',
      help: '근속만으로 받을 수 있는 최대 점수. 고용형태 가산은 이 위에 더해집니다.',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'permanent_bonus',
      label: '정규직 가산',
      help: '',
      type: 'number',
      min: 0,
      max: 50,
      step: 1,
    },
    {
      key: 'probation_scores_zero',
      label: '수습은 0점',
      help: '수습 기간 중 대출을 제한하는 정책이면 켜둡니다.',
      type: 'boolean',
    },
  ],
  pay_stability: [
    {
      key: 'cv_multiplier',
      label: '변동계수 배수',
      help: '100 − 변동계수 × 이 값. 클수록 실수령 변동에 엄격해집니다 (400이면 변동계수 25%에서 0점).',
      type: 'number',
      min: 0,
      max: 2000,
      step: 10,
    },
    {
      key: 'min_months',
      label: '판단에 필요한 최소 개월수',
      help: '',
      type: 'number',
      min: 1,
      max: 24,
      step: 1,
    },
    {
      key: 'insufficient_score',
      label: '이력 부족 시 점수',
      help: '최소 개월수에 못 미치면 이 점수를 줍니다.',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
  ],
};

export type Curve = Record<string, number | boolean>;

export const CURVE_DEFAULTS: Record<string, Curve> = {
  attendance: { zero_at_percent: 0, absence_penalty: 5 },
  repayment: { no_history: 60, base: 70, per_completed: 10, max_completed: 3, late_penalty: 30 },
  tenure: { per_year: 18, years_cap: 90, permanent_bonus: 10, probation_scores_zero: true },
  pay_stability: { cv_multiplier: 400, min_months: 2, insufficient_score: 50 },
};

/** Fills in anything the stored curve is missing, so a partial row still scores. */
export function withDefaults(code: string, stored: unknown): Curve {
  const defaults = CURVE_DEFAULTS[code] ?? {};
  if (!stored || typeof stored !== 'object') return { ...defaults };
  return { ...defaults, ...(stored as Curve) };
}

export interface CurveProblem {
  code: string;
  key: string;
  reason: string;
}

/**
 * Checks a curve before it is saved.
 *
 * Range-checked per field, and then checked as a whole where the fields
 * interact: a repayment curve whose no-history score sits above what a clean
 * borrower can reach would score never having borrowed as better than having
 * repaid, which is not a risk position anybody means to take.
 */
export function validateCurve(code: string, curve: Curve): CurveProblem[] {
  const fields = CURVE_FIELDS[code];
  if (!fields) return [{ code, key: '-', reason: '알 수 없는 항목입니다.' }];

  const problems: CurveProblem[] = [];
  for (const f of fields) {
    const v = curve[f.key];
    if (v === undefined || v === null) {
      problems.push({ code, key: f.key, reason: '값이 없습니다.' });
      continue;
    }
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') problems.push({ code, key: f.key, reason: 'true/false 여야 합니다.' });
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push({ code, key: f.key, reason: '숫자여야 합니다.' });
      continue;
    }
    if (f.min !== undefined && v < f.min) {
      problems.push({ code, key: f.key, reason: `${f.min} 이상이어야 합니다.` });
    }
    if (f.max !== undefined && v > f.max) {
      problems.push({ code, key: f.key, reason: `${f.max} 이하여야 합니다.` });
    }
  }
  if (problems.length > 0) return problems;

  if (code === 'repayment') {
    const clean = Number(curve.base) + Number(curve.per_completed) * Number(curve.max_completed);
    if (Number(curve.no_history) > Math.min(clean, 100)) {
      problems.push({
        code,
        key: 'no_history',
        reason: `이력 없음(${curve.no_history})이 완주 이력 최고점(${Math.min(clean, 100)})보다 높습니다. 빌린 적 없는 사람이 잘 갚은 사람보다 높게 평가됩니다.`,
      });
    }
  }
  if (code === 'tenure') {
    if (Number(curve.years_cap) + Number(curve.permanent_bonus) > 100) {
      problems.push({
        code,
        key: 'years_cap',
        reason: `근속 상한(${curve.years_cap}) + 정규직 가산(${curve.permanent_bonus})이 100을 넘어, 가산이 일부 무시됩니다.`,
      });
    }
  }
  return problems;
}

/** A worked example, so the effect of a change is visible before it is saved. */
export interface CurvePreviewRow {
  input: string;
  score: number;
}

export function previewCurve(
  code: string,
  curve: Curve,
  normalize: (code: string, curve: Curve, sample: number[]) => number
): CurvePreviewRow[] {
  const samples: Record<string, { label: string; args: number[] }[]> = {
    attendance: [
      { label: '출근율 100% · 결근 0', args: [100, 0] },
      { label: '출근율 99% · 결근 0', args: [99, 0] },
      { label: '출근율 95% · 결근 0', args: [95, 0] },
      { label: '출근율 95% · 결근 2', args: [95, 2] },
      { label: '출근율 90% · 결근 0', args: [90, 0] },
    ],
    repayment: [
      { label: '이력 없음', args: [0, 0] },
      { label: '완주 1 · 연체 0', args: [1, 0] },
      { label: '완주 3 · 연체 0', args: [3, 0] },
      { label: '완주 1 · 연체 1', args: [1, 1] },
      { label: '완주 2 · 연체 3', args: [2, 3] },
    ],
    tenure: [
      { label: '근속 0.5년 · 정규직', args: [0.5, 1] },
      { label: '근속 2년 · 정규직', args: [2, 1] },
      { label: '근속 5년 · 정규직', args: [5, 1] },
      { label: '근속 5년 · 계약직', args: [5, 0] },
      { label: '수습', args: [0.3, -1] },
    ],
    pay_stability: [
      { label: '변동계수 1%', args: [0.01] },
      { label: '변동계수 5%', args: [0.05] },
      { label: '변동계수 15%', args: [0.15] },
      { label: '변동계수 30%', args: [0.3] },
      { label: '이력 1개월', args: [-1] },
    ],
  };
  return (samples[code] ?? []).map((s) => ({
    input: s.label,
    score: normalize(code, curve, s.args),
  }));
}
