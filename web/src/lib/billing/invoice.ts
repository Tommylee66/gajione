/**
 * What a customer is charged for a month.
 *
 * Pure, because an invoice is a number somebody pays and then queries. It has
 * to be reproducible from the same inputs, and the breakdown has to say how it
 * was reached — "why is it 28.5 million" is the first question, and "because
 * the system said so" is not an answer.
 */

export interface VolumeTier {
  /** Headcount above which the discount applies. */
  over: number;
  /** Percent off the per-employee fee, for the heads above `over`. */
  discount_percent: number;
}

export interface PlanPricing {
  code: string;
  name: string;
  base_fee: number;
  per_employee_fee: number;
  whitelabel_fee: number;
  whitelabel_monthly_fee: number;
  volume_tiers: VolumeTier[];
  annual_prepay_discount: number;
}

export interface BillingInput {
  plan: PlanPricing;
  employeeCount: number;
  whitelabel: boolean;
  /** True in the month the white-label add-on is first set up. */
  whitelabelSetupDue: boolean;
  annualPrepay: boolean;
  /** A negotiated discount on the subscription, on top of the plan's own. */
  contractDiscountPercent: number;
}

export interface TierApplication {
  from: number;
  to: number | null;
  heads: number;
  rate: number;
  discount_percent: number;
  amount: number;
}

export interface Invoice {
  employeeCount: number;
  baseAmount: number;
  perEmployeeAmount: number;
  whitelabelAmount: number;
  discountAmount: number;
  totalAmount: number;
  breakdown: {
    plan_code: string;
    tiers: TierApplication[];
    annual_prepay_discount: number;
    contract_discount: number;
    whitelabel_setup: number;
    whitelabel_monthly: number;
  };
}

/**
 * Volume tiers are marginal, not cliff.
 *
 * A cliff would mean the 201st employee makes the whole bill cheaper than it
 * was at 200 — so a customer at 199 is charged more than one at 201, which is
 * indefensible the first time somebody puts the two invoices side by side.
 * Each band is charged at its own rate, the way income tax works.
 */
export function applyTiers(
  count: number,
  baseRate: number,
  tiers: VolumeTier[]
): TierApplication[] {
  const sorted = [...tiers]
    .filter((t) => Number.isFinite(t.over) && t.over >= 0)
    .sort((a, b) => a.over - b.over);

  const out: TierApplication[] = [];
  let from = 0;
  let discount = 0;

  for (const tier of sorted) {
    if (count <= tier.over) break;
    const heads = tier.over - from;
    if (heads > 0) {
      const rate = Math.round(baseRate * (1 - discount / 100));
      out.push({ from: from + 1, to: tier.over, heads, rate, discount_percent: discount, amount: heads * rate });
    }
    from = tier.over;
    discount = tier.discount_percent;
  }

  const heads = count - from;
  if (heads > 0) {
    const rate = Math.round(baseRate * (1 - discount / 100));
    out.push({ from: from + 1, to: null, heads, rate, discount_percent: discount, amount: heads * rate });
  }
  return out;
}

export function buildInvoice(input: BillingInput): Invoice {
  const count = Math.max(0, Math.round(input.employeeCount));
  const tiers = applyTiers(count, input.plan.per_employee_fee, input.plan.volume_tiers);
  const perEmployeeAmount = tiers.reduce((s, t) => s + t.amount, 0);

  const whitelabelSetup =
    input.whitelabel && input.whitelabelSetupDue ? input.plan.whitelabel_fee : 0;
  const whitelabelMonthly = input.whitelabel ? input.plan.whitelabel_monthly_fee : 0;
  const whitelabelAmount = whitelabelSetup + whitelabelMonthly;

  const subtotal = input.plan.base_fee + perEmployeeAmount + whitelabelAmount;

  // Applied to the subtotal, and the two stack additively rather than
  // compounding: a 10% plan discount and a 5% contract discount is 15% off,
  // which is what both parties think they agreed.
  const prepay = input.annualPrepay ? input.plan.annual_prepay_discount : 0;
  const totalDiscountPercent = Math.min(100, prepay + Math.max(0, input.contractDiscountPercent));
  const discountAmount = Math.round((subtotal * totalDiscountPercent) / 100);

  return {
    employeeCount: count,
    baseAmount: input.plan.base_fee,
    perEmployeeAmount,
    whitelabelAmount,
    discountAmount,
    totalAmount: subtotal - discountAmount,
    breakdown: {
      plan_code: input.plan.code,
      tiers,
      annual_prepay_discount: prepay,
      contract_discount: Math.max(0, input.contractDiscountPercent),
      whitelabel_setup: whitelabelSetup,
      whitelabel_monthly: whitelabelMonthly,
    },
  };
}

export interface PricingProblem {
  field: string;
  reason: string;
}

export function validatePricing(plan: PlanPricing): PricingProblem[] {
  const out: PricingProblem[] = [];
  if (!(plan.base_fee >= 0)) out.push({ field: 'base_fee', reason: '기본요금은 0 이상이어야 합니다.' });
  if (!(plan.per_employee_fee >= 0)) {
    out.push({ field: 'per_employee_fee', reason: '인당 요금은 0 이상이어야 합니다.' });
  }
  if (plan.annual_prepay_discount < 0 || plan.annual_prepay_discount > 100) {
    out.push({ field: 'annual_prepay_discount', reason: '연간 선결제 할인율은 0~100%여야 합니다.' });
  }

  const seen = new Set<number>();
  const sorted = [...plan.volume_tiers].sort((a, b) => a.over - b.over);
  let previous = -1;
  for (const t of sorted) {
    if (!Number.isFinite(t.over) || t.over < 1) {
      out.push({ field: 'volume_tiers', reason: '볼륨 구간 기준 인원은 1명 이상이어야 합니다.' });
      continue;
    }
    if (seen.has(t.over)) {
      out.push({ field: 'volume_tiers', reason: `${t.over}명 구간이 중복됩니다.` });
    }
    seen.add(t.over);
    if (t.discount_percent < 0 || t.discount_percent >= 100) {
      out.push({ field: 'volume_tiers', reason: '볼륨 할인율은 0~99% 사이여야 합니다.' });
    }
    // A later tier discounting less than an earlier one means the bill rises
    // as headcount does past that point, which nobody means to price.
    if (previous >= 0 && t.discount_percent < previous) {
      out.push({
        field: 'volume_tiers',
        reason: `${t.over}명 구간 할인율(${t.discount_percent}%)이 이전 구간(${previous}%)보다 낮습니다.`,
      });
    }
    previous = t.discount_percent;
  }
  return out;
}

export const COMPANY_STATUS_LABELS: Record<string, string> = {
  active: '활성',
  trial: '체험중',
  churning: '해지예정',
  suspended: '정지',
  closed: '종료',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: '초안',
  issued: '발행',
  paid: '수납',
  void: '취소',
};
