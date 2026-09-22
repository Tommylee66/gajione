/**
 * Loan offer terms and what they cost.
 *
 * Pure, because the instalment on an offer is the number an employee decides
 * on and then sees deducted for the next ten months. It has to be the same
 * number every time it is computed, and checkable by anyone who doubts it.
 *
 * GajiOne does not set these terms — the lender does. This module only works
 * out what the terms they entered come to.
 */

export type RepaymentMethod = 'annuity' | 'equal_principal';

export const REPAYMENT_LABELS: Record<RepaymentMethod, string> = {
  annuity: '원리금균등',
  equal_principal: '원금균등',
};

export interface OfferTerms {
  principal: number;
  /** Annual nominal rate in percent, e.g. 18 for 18%. */
  annualRate: number;
  months: number;
  /** One-off fee as a percent of principal. */
  feePercent: number;
  method: RepaymentMethod;
}

export interface OfferSchedule {
  /** What the payroll deduction will be. Under equal_principal this is the last, smallest instalment. */
  monthlyAmount: number;
  /** The first month's instalment; equal to monthlyAmount under annuity. */
  firstMonthAmount: number;
  feeAmount: number;
  totalRepayment: number;
  totalInterest: number;
  /** Every instalment, for the schedule the employee is shown. */
  instalments: { no: number; principal: number; interest: number; total: number; balance: number }[];
}

/**
 * Both methods, because Indonesian lenders use both and they differ by more
 * than rounding: annuity is flat month to month, equal-principal starts high
 * and falls. Quoting one while charging the other is the kind of mismatch that
 * surfaces on instalment three.
 */
export function buildSchedule(terms: OfferTerms): OfferSchedule {
  const months = Math.max(1, Math.round(terms.months));
  const principal = Math.max(0, terms.principal);
  const monthlyRate = terms.annualRate / 100 / 12;
  const feeAmount = Math.round((principal * terms.feePercent) / 100);

  const instalments: OfferSchedule['instalments'] = [];
  let balance = principal;

  if (terms.method === 'annuity') {
    // A zero rate would divide by zero in the annuity formula; it is also a
    // perfectly ordinary staff loan.
    const payment =
      monthlyRate === 0
        ? principal / months
        : (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
    const rounded = Math.round(payment);
    for (let n = 1; n <= months; n++) {
      const interest = Math.round(balance * monthlyRate);
      // The last instalment clears the balance rather than leaving a few
      // rupiah behind, which is what rounding every month would do.
      const total = n === months ? balance + interest : rounded;
      const principalPart = total - interest;
      balance = Math.max(0, balance - principalPart);
      instalments.push({ no: n, principal: principalPart, interest, total, balance });
    }
    return {
      monthlyAmount: rounded,
      firstMonthAmount: rounded,
      feeAmount,
      totalRepayment: instalments.reduce((s, i) => s + i.total, 0),
      totalInterest: instalments.reduce((s, i) => s + i.interest, 0),
      instalments,
    };
  }

  const principalPart = Math.round(principal / months);
  for (let n = 1; n <= months; n++) {
    const interest = Math.round(balance * monthlyRate);
    const part = n === months ? balance : principalPart;
    balance = Math.max(0, balance - part);
    instalments.push({ no: n, principal: part, interest, total: part + interest, balance });
  }
  return {
    // The deduction ceiling has to be checked against the largest instalment,
    // which under equal principal is the first one.
    monthlyAmount: instalments[0].total,
    firstMonthAmount: instalments[0].total,
    feeAmount,
    totalRepayment: instalments.reduce((s, i) => s + i.total, 0),
    totalInterest: instalments.reduce((s, i) => s + i.interest, 0),
    instalments,
  };
}

export interface OfferProblem {
  field: string;
  reason: string;
}

/** What a partner may not enter. Bounds, not credit judgement. */
export function validateOffer(terms: OfferTerms): OfferProblem[] {
  const out: OfferProblem[] = [];
  if (!(terms.principal > 0)) out.push({ field: 'principal', reason: '대출 원금이 0보다 커야 합니다.' });
  if (!Number.isFinite(terms.annualRate) || terms.annualRate < 0) {
    out.push({ field: 'annualRate', reason: '연 이자율은 0 이상이어야 합니다.' });
  }
  // Not a credit view: OJK caps consumer lending well below this, and a rate
  // above it is a typo — 180 entered where 18 was meant.
  if (terms.annualRate > 60) {
    out.push({ field: 'annualRate', reason: '연 이자율이 60%를 넘습니다. 입력을 확인하세요.' });
  }
  if (!Number.isInteger(terms.months) || terms.months < 1 || terms.months > 60) {
    out.push({ field: 'months', reason: '상환기간은 1~60개월이어야 합니다.' });
  }
  if (!Number.isFinite(terms.feePercent) || terms.feePercent < 0 || terms.feePercent > 10) {
    out.push({ field: 'feePercent', reason: '수수료는 0~10% 사이여야 합니다.' });
  }
  return out;
}

export const OFFER_STATUS_LABELS: Record<string, string> = {
  sent: '수락 대기',
  accepted: '수락됨',
  declined: '거절됨',
  expired: '기한 만료',
  withdrawn: '철회됨',
  disbursed: '실행 완료',
};

/**
 * The four stages the mockup shows. Derived from the offer rather than stored,
 * so a stage cannot claim to be complete while the record says otherwise.
 */
export interface OfferStage {
  no: number;
  label: string;
  state: 'done' | 'active' | 'waiting';
}

export function offerStages(status: string, hasMandate: boolean): OfferStage[] {
  const accepted = status === 'accepted' || status === 'disbursed';
  const disbursed = status === 'disbursed';
  const dead = status === 'declined' || status === 'expired' || status === 'withdrawn';
  return [
    { no: 1, label: '오퍼 발송', state: 'done' },
    {
      no: 2,
      label: '직원 수락',
      state: accepted ? 'done' : dead ? 'waiting' : 'active',
    },
    {
      no: 3,
      label: '대출 실행',
      state: disbursed ? 'done' : accepted ? 'active' : 'waiting',
    },
    {
      no: 4,
      label: '급여공제 등록',
      state: hasMandate ? 'done' : disbursed ? 'active' : 'waiting',
    },
  ];
}

/** True once an offer can no longer be acted on. */
export function isExpired(expiresAt: string, now = new Date()): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}
