/**
 * G3 rule evaluation.
 *
 * The mockup runs fourteen automatic rules and advances with twelve passing,
 * so severity is a property of each rule rather than of the gate: a warning
 * annotates, a blocking failure stops the run. What actually holds G3 shut in
 * the mockup is not a rule at all — it is the two unexplained variances, which
 * are people's judgement and cannot be automated away.
 *
 * Pure, like the calculation engine, so the same run always evaluates the same
 * way and a result can be recomputed to check it.
 */

export interface GateItem {
  employee_id: string;
  employee_no: string;
  employee_name: string;
  department_id: string | null;
  base_salary: number;
  gross: number;
  deduction_total: number;
  net: number;
  prev_net: number | null;
  umk_region?: string | null;
  /** Sum of the stored lines, used to check the totals against their parts. */
  line_sum_earning: number;
  line_sum_deduction: number;
  loan_deduction: number;
}

export interface GateRule {
  code: string;
  name: string;
  gate: string;
  severity: 'blocking' | 'warning';
  threshold: number | null;
  legal_basis: string | null;
}

export interface GateContext {
  items: GateItem[];
  rules: GateRule[];
  recalcHashesAgree: boolean;
  taxVersion: string | null;
  bpjsVersion: string | null;
  maxLoanDeductionRate: number;
  umkByRegion: Map<string, number>;
}

export interface GateResult {
  code: string;
  name: string;
  severity: 'blocking' | 'warning';
  passed: boolean;
  detail: string;
  /** Employees the rule flagged, for the screen to list. */
  offenders: string[];
  legal_basis: string | null;
}

export interface VarianceCandidate {
  employee_id: string;
  employee_no: string;
  employee_name: string;
  department_id: string | null;
  prev_net: number;
  curr_net: number;
  change_rate: number;
}

const DEFAULT_VARIANCE_THRESHOLD = 20;

export function findVariances(items: GateItem[], thresholdPercent: number): VarianceCandidate[] {
  const out: VarianceCandidate[] = [];
  for (const i of items) {
    // A first payslip has nothing to compare against. Flagging every new
    // joiner as a variance would bury the cases that matter.
    if (i.prev_net === null || i.prev_net <= 0) continue;
    const rate = ((i.net - i.prev_net) / i.prev_net) * 100;
    if (Math.abs(rate) <= thresholdPercent) continue;
    out.push({
      employee_id: i.employee_id,
      employee_no: i.employee_no,
      employee_name: i.employee_name,
      department_id: i.department_id,
      prev_net: i.prev_net,
      curr_net: i.net,
      change_rate: rate,
    });
  }
  return out.sort((a, b) => Math.abs(b.change_rate) - Math.abs(a.change_rate));
}

export function evaluateG3(ctx: GateContext): {
  results: GateResult[];
  variances: VarianceCandidate[];
} {
  const byCode = new Map(ctx.rules.map((r) => [r.code, r]));
  const results: GateResult[] = [];

  const rule = (code: string, fallbackName: string, fallbackSeverity: 'blocking' | 'warning') =>
    byCode.get(code) ?? {
      code,
      name: fallbackName,
      gate: 'G3',
      severity: fallbackSeverity,
      threshold: null,
      legal_basis: null,
    };

  // --- Totals reconcile against their parts ---------------------------------
  // The mockup lists this as "구성합계 = 총계 대사 일치". It catches a stored
  // total that no longer matches the lines under it — which is what a partial
  // write or a hand-edited row looks like.
  const mismatched = ctx.items.filter(
    (i) =>
      Math.abs(i.line_sum_earning - i.gross) > 1 ||
      Math.abs(i.line_sum_deduction - i.deduction_total) > 1
  );
  const sumRule = rule('G2_SUM_RECONCILE', '구성합계 = 총계 대사', 'blocking');
  results.push({
    code: sumRule.code,
    name: sumRule.name,
    severity: 'blocking',
    passed: mismatched.length === 0,
    detail: mismatched.length === 0 ? '전원 일치' : `${mismatched.length}명 불일치`,
    offenders: mismatched.map((i) => i.employee_no),
    legal_basis: null,
  });

  // --- No zero or negative pay ---------------------------------------------
  const nonPositive = ctx.items.filter((i) => i.net <= 0);
  results.push({
    code: 'G2_NET_POSITIVE',
    name: '음수·0원 급여 없음',
    severity: 'blocking',
    passed: nonPositive.length === 0,
    detail: nonPositive.length === 0 ? '0건' : `${nonPositive.length}명`,
    offenders: nonPositive.map((i) => i.employee_no),
    legal_basis: null,
  });

  // --- Parallel recomputation ----------------------------------------------
  const recalcRule = rule('G2_RECALC_MATCH', '병렬 재계산 일치', 'blocking');
  results.push({
    code: recalcRule.code,
    name: recalcRule.name,
    severity: 'blocking',
    passed: ctx.recalcHashesAgree,
    detail: ctx.recalcHashesAgree
      ? `${ctx.items.length}/${ctx.items.length}`
      : '두 번의 계산이 불일치',
    offenders: [],
    legal_basis: null,
  });

  // --- Rate versions pinned ------------------------------------------------
  const versionRule = rule('G2_RATE_VERSION', '요율 버전 고정', 'blocking');
  const versionsPinned = Boolean(ctx.taxVersion && ctx.bpjsVersion);
  results.push({
    code: versionRule.code,
    name: versionRule.name,
    severity: 'blocking',
    passed: versionsPinned,
    detail: versionsPinned
      ? `${ctx.taxVersion} · ${ctx.bpjsVersion}`
      : '차수에 요율 버전이 기록되지 않았습니다',
    offenders: [],
    legal_basis: null,
  });

  // --- Minimum wage ---------------------------------------------------------
  // A missing UMK counts as a failure, not a skip. A region with no figure on
  // file would otherwise pass every employee in it while checking nothing.
  const umkRule = rule('G2_UMK_FLOOR', 'UMK 미달 검사', 'blocking');
  const umkOffenders: string[] = [];
  const umkMissing: string[] = [];
  for (const i of ctx.items) {
    if (!i.umk_region) continue;
    const umk = ctx.umkByRegion.get(i.umk_region);
    if (umk === undefined) umkMissing.push(i.employee_no);
    else if (i.base_salary < umk) umkOffenders.push(i.employee_no);
  }
  results.push({
    code: umkRule.code,
    name: umkRule.name,
    severity: 'blocking',
    passed: umkOffenders.length === 0 && umkMissing.length === 0,
    detail:
      umkMissing.length > 0
        ? `${umkMissing.length}명의 지역 UMK가 등록되어 있지 않습니다`
        : umkOffenders.length === 0
          ? '미달 0명'
          : `${umkOffenders.length}명 미달`,
    offenders: [...umkOffenders, ...umkMissing],
    legal_basis: umkRule.legal_basis ?? 'UMK 규정',
  });

  // --- Loan deduction ceiling ----------------------------------------------
  const loanRule = rule('G3_LOAN_CAP', '대출 공제 상한', 'blocking');
  const loanCapPercent = loanRule.threshold ?? ctx.maxLoanDeductionRate;
  const overLoan = ctx.items.filter(
    (i) => i.loan_deduction > 0 && i.net > 0 && (i.loan_deduction / i.net) * 100 > loanCapPercent + 0.01
  );
  results.push({
    code: loanRule.code,
    name: loanRule.name,
    severity: 'blocking',
    passed: overLoan.length === 0,
    detail: overLoan.length === 0 ? `실지급 ${loanCapPercent}% 이내 전원 충족` : `${overLoan.length}명 초과`,
    offenders: overLoan.map((i) => i.employee_no),
    legal_basis: null,
  });

  // --- Net variance ---------------------------------------------------------
  const varianceRule = rule('G3_NET_VARIANCE', '순지급 변동 검출', 'blocking');
  const threshold = varianceRule.threshold ?? DEFAULT_VARIANCE_THRESHOLD;
  const variances = findVariances(ctx.items, threshold);
  results.push({
    code: varianceRule.code,
    name: varianceRule.name,
    severity: 'blocking',
    // The rule's job is to find them, not to clear them. Whether the run can
    // advance depends on the explanations, which are handled separately.
    passed: variances.length === 0,
    detail:
      variances.length === 0
        ? `±${threshold}% 초과 0명`
        : `±${threshold}% 초과 ${variances.length}명 — 소명 필요`,
    offenders: variances.map((v) => v.employee_no),
    legal_basis: null,
  });

  return { results, variances };
}

/**
 * Whether G3 can close.
 *
 * Two conditions, and they are different in kind: every blocking rule other
 * than the variance detector has to pass, and every variance case has to have
 * been decided by a person. Automation cannot substitute for the second.
 */
export function canPassG3(
  results: GateResult[],
  openVariances: number,
  rejectedVariances: number
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const r of results) {
    if (r.code === 'G3_NET_VARIANCE') continue;
    if (r.severity === 'blocking' && !r.passed) reasons.push(r.name);
  }
  if (openVariances > 0) reasons.push(`소명 대기 ${openVariances}건`);
  if (rejectedVariances > 0) reasons.push(`반려된 소명 ${rejectedVariances}건`);
  return { ok: reasons.length === 0, reasons };
}
