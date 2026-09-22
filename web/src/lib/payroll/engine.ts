/**
 * The payroll calculation.
 *
 * Pure: everything it needs is passed in, nothing is fetched, and the same
 * inputs always give the same output. That is what makes the double
 * computation in G2 meaningful — two passes over identical inputs must agree
 * on a hash, and a difference is a real bug rather than a timing artefact.
 *
 * Money is handled in whole rupiah with rounding applied where the policy says
 * (per line or on the total only). Intermediate values stay unrounded so the
 * rounding happens once, at the point the policy names.
 */

export interface EngineEmployee {
  id: string;
  employee_no: string;
  full_name: string;
  department_id: string | null;
  position_id: string | null;
  base_salary: number;
  ptkp_status: string | null;
  umk_region: string | null;
  join_date: string;
  resign_date: string | null;
}

export interface EngineComponent {
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  calc_type: 'fixed' | 'rate_of_base' | 'formula' | 'per_attendance';
  amount: number | null;
  taxable: boolean;
  bpjs_base: boolean;
  prorate: boolean;
  ot_base: boolean;
  sort_order: number;
}

export interface EngineOtBracket {
  day_type: 'weekday' | 'holiday' | 'national_holiday';
  from_hour: number;
  to_hour: number | null;
  multiplier: number;
  multiplier_max: number | null;
  legal_basis: string | null;
}

export interface EngineBpjs {
  program: string;
  employee_rate: number;
  employer_rate: number;
  wage_cap: number | null;
}

export interface EngineTaxBand {
  category: string;
  lower_bound: number;
  upper_bound: number | null;
  rate: number;
}

export interface EnginePolicy {
  ot_hour_divisor: number;
  rounding_scope: 'line' | 'total';
  rounding_unit: number;
  proration_basis: 'calendar' | 'fixed_30' | 'working_days';
  max_loan_deduction_rate: number;
}

export interface EngineAttendance {
  employee_id: string;
  work_days: number;
  /** Overtime split by the bracket it falls in, already matched by G1. */
  ot_by_bracket: { day_type: EngineOtBracket['day_type']; hours: number }[];
}

export interface EngineLoanDeduction {
  employee_id: string;
  mandate_id: string;
  lender_name: string;
  amount: number;
}

export interface EngineInput {
  period: string;
  cutoffStart: string;
  cutoffEnd: string;
  employees: EngineEmployee[];
  components: EngineComponent[];
  otBrackets: EngineOtBracket[];
  bpjs: EngineBpjs[];
  taxBands: EngineTaxBand[];
  policy: EnginePolicy;
  attendance: Map<string, EngineAttendance>;
  loans: EngineLoanDeduction[];
  umkByRegion: Map<string, number>;
}

export interface ResultLine {
  component_code: string | null;
  component_name: string;
  kind: 'earning' | 'deduction';
  quantity: number | null;
  rate: number | null;
  amount: number;
  taxable: boolean;
  bpjs_base: boolean;
  legal_basis: string | null;
  sort_order: number;
}

export interface ResultOtLine {
  day_type: string;
  bracket_label: string;
  multiplier: number;
  hours: number;
  hourly_rate: number;
  amount: number;
  legal_basis: string | null;
}

export interface EmployeeResult {
  employee_id: string;
  employee_no: string;
  employee_name: string;
  department_id: string | null;
  position_id: string | null;
  base_salary: number;
  ptkp_status: string | null;
  work_days: number;
  ot_minutes: number;
  gross: number;
  taxable_gross: number;
  bpjs_base: number;
  deduction_total: number;
  net: number;
  lines: ResultLine[];
  otLines: ResultOtLine[];
  /** Raised when the result itself is suspect, not when a rule is breached. */
  warnings: string[];
}

export interface EngineOutput {
  results: EmployeeResult[];
  gross_total: number;
  deduction_total: number;
  net_total: number;
}

/**
 * PTKP status decides which TER schedule applies.
 *
 * Taken from PP 58/2023 art. 2(4) verbatim, not inferred:
 *   A — tidak kawin tanpa tanggungan (TK/0), tidak kawin dengan 1 tanggungan
 *       (TK/1), kawin tanpa tanggungan (K/0)
 *   B — TK/2, TK/3, K/1, K/2
 *   C — K/3
 * The regulation's own PTKP figures line up: A is 54/58.5 juta, B 63/67.5
 * juta, C 72 juta.
 */
const TER_CATEGORY: Record<string, string> = {
  'TK/0': 'A',
  'TK/1': 'A',
  'K/0': 'A',
  'TK/2': 'B',
  'TK/3': 'B',
  'K/1': 'B',
  'K/2': 'B',
  'K/3': 'C',
};

export function terCategory(ptkp: string | null): string | null {
  if (!ptkp) return null;
  return TER_CATEGORY[ptkp.toUpperCase()] ?? null;
}

function roundTo(value: number, unit: number): number {
  if (unit <= 1) return Math.round(value);
  return Math.round(value / unit) * unit;
}

function daysInMonth(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The fraction of the period an employee was actually employed for. Someone
 * who joined on the 10th is not owed a full month, and someone who left
 * mid-period is owed up to their last day.
 */
function prorationFactor(
  employee: EngineEmployee,
  cutoffStart: string,
  cutoffEnd: string,
  basis: EnginePolicy['proration_basis'],
  period: string
): number {
  const start = new Date(`${cutoffStart}T00:00:00Z`);
  const end = new Date(`${cutoffEnd}T00:00:00Z`);
  const join = new Date(`${employee.join_date}T00:00:00Z`);
  const leave = employee.resign_date ? new Date(`${employee.resign_date}T00:00:00Z`) : null;

  const from = join > start ? join : start;
  const to = leave && leave < end ? leave : end;
  if (to < from) return 0;

  const coveredDays = Math.round((to.getTime() - from.getTime()) / 86400_000) + 1;
  const totalDays =
    basis === 'fixed_30'
      ? 30
      : basis === 'calendar'
        ? daysInMonth(period)
        : Math.round((end.getTime() - start.getTime()) / 86400_000) + 1;

  return Math.min(1, coveredDays / totalDays);
}

const BRACKET_LABELS: Record<string, string> = {
  weekday: '평일',
  holiday: '휴일',
  national_holiday: '공휴일',
};

export function calculate(input: EngineInput): EngineOutput {
  const { policy } = input;
  const roundLine = (v: number) =>
    policy.rounding_scope === 'line' ? roundTo(v, policy.rounding_unit) : v;

  const loansByEmployee = new Map<string, EngineLoanDeduction[]>();
  for (const l of input.loans) {
    const list = loansByEmployee.get(l.employee_id) ?? [];
    list.push(l);
    loansByEmployee.set(l.employee_id, list);
  }

  const results: EmployeeResult[] = [];

  for (const e of input.employees) {
    const warnings: string[] = [];
    const lines: ResultLine[] = [];
    const otLines: ResultOtLine[] = [];

    const factor = prorationFactor(
      e,
      input.cutoffStart,
      input.cutoffEnd,
      policy.proration_basis,
      input.period
    );
    const attendance = input.attendance.get(e.id);
    const workDays = attendance?.work_days ?? 0;

    // --- Base salary -------------------------------------------------------
    const basePay = roundLine(e.base_salary * factor);
    lines.push({
      component_code: 'BASE',
      component_name: '기본급',
      kind: 'earning',
      quantity: factor < 1 ? factor : null,
      rate: e.base_salary,
      amount: basePay,
      taxable: true,
      bpjs_base: true,
      legal_basis: null,
      sort_order: 0,
    });

    // --- Allowances and fixed deductions ----------------------------------
    for (const c of input.components) {
      let amount = 0;
      if (c.calc_type === 'fixed') amount = c.amount ?? 0;
      else if (c.calc_type === 'rate_of_base') amount = e.base_salary * (c.amount ?? 0);
      else if (c.calc_type === 'per_attendance') amount = (c.amount ?? 0) * workDays;
      else {
        // 'formula' has no evaluator yet. Skipped with a warning rather than
        // silently contributing zero, which would understate the payslip.
        warnings.push(`수식 항목 "${c.name}" 은 아직 계산되지 않습니다.`);
        continue;
      }
      if (c.prorate && c.calc_type !== 'per_attendance') amount *= factor;
      if (amount === 0) continue;

      lines.push({
        component_code: c.code,
        component_name: c.name,
        kind: c.kind,
        quantity: c.calc_type === 'per_attendance' ? workDays : null,
        rate: c.amount,
        amount: roundLine(amount),
        taxable: c.taxable,
        bpjs_base: c.bpjs_base,
        legal_basis: null,
        sort_order: c.sort_order + 1,
      });
    }

    // --- Overtime ----------------------------------------------------------
    // Kepmenakertrans 102/2004: hourly rate is the monthly wage over 173,
    // where the monthly wage is base plus the allowances marked ot_base.
    const otBaseMonthly =
      e.base_salary +
      input.components
        .filter((c) => c.ot_base && c.kind === 'earning' && c.calc_type === 'fixed')
        .reduce((s, c) => s + (c.amount ?? 0), 0);
    const hourlyRate = otBaseMonthly / policy.ot_hour_divisor;

    let otMinutes = 0;
    for (const entry of attendance?.ot_by_bracket ?? []) {
      if (entry.hours <= 0) continue;
      otMinutes += Math.round(entry.hours * 60);

      let remaining = entry.hours;
      const brackets = input.otBrackets
        .filter((b) => b.day_type === entry.day_type)
        .sort((a, b) => a.from_hour - b.from_hour);

      for (const b of brackets) {
        if (remaining <= 0) break;
        const span = b.to_hour === null ? remaining : Math.max(0, b.to_hour - b.from_hour);
        const hours = Math.min(remaining, span);
        if (hours <= 0) continue;
        remaining -= hours;

        if (b.multiplier_max !== null && b.multiplier_max !== b.multiplier) {
          // The holiday band is quoted as a range in the source material. The
          // floor is applied and the fact is surfaced rather than silently
          // choosing an end of it.
          warnings.push(
            `${BRACKET_LABELS[b.day_type]} ${b.from_hour}시간 이후 배율이 ${b.multiplier}~${b.multiplier_max} 범위입니다. 하한을 적용했습니다.`
          );
        }

        const amount = roundLine(hours * hourlyRate * b.multiplier);
        otLines.push({
          day_type: b.day_type,
          bracket_label: `${BRACKET_LABELS[b.day_type]} ${b.from_hour}시간${b.to_hour === null ? ' 이후' : `~${b.to_hour}시간`}`,
          multiplier: b.multiplier,
          hours,
          hourly_rate: hourlyRate,
          amount,
          legal_basis: b.legal_basis,
        });
      }

      if (remaining > 0.01) {
        warnings.push(
          `${BRACKET_LABELS[entry.day_type]} 초과근무 ${remaining.toFixed(1)}시간에 해당하는 배율 구간이 없습니다.`
        );
      }
    }

    const otTotal = otLines.reduce((s, l) => s + l.amount, 0);
    if (otTotal > 0) {
      lines.push({
        component_code: 'OT',
        component_name: '초과근무수당',
        kind: 'earning',
        quantity: otMinutes / 60,
        rate: hourlyRate,
        amount: otTotal,
        taxable: true,
        bpjs_base: false,
        legal_basis: 'Kepmenakertrans 102/2004',
        sort_order: 50,
      });
    }

    // --- Bases -------------------------------------------------------------
    const earnings = lines.filter((l) => l.kind === 'earning');
    const gross = earnings.reduce((s, l) => s + l.amount, 0);
    const taxableGross = earnings.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0);
    const bpjsBase = earnings.filter((l) => l.bpjs_base).reduce((s, l) => s + l.amount, 0);

    // --- BPJS --------------------------------------------------------------
    for (const b of input.bpjs) {
      if (b.employee_rate <= 0) continue;
      // The cap applies to the contributable wage, not the contribution.
      const capped = b.wage_cap === null ? bpjsBase : Math.min(bpjsBase, b.wage_cap);
      const amount = roundLine(capped * b.employee_rate);
      if (amount <= 0) continue;
      lines.push({
        component_code: `BPJS_${b.program.toUpperCase()}`,
        component_name: `BPJS ${b.program.toUpperCase()}`,
        kind: 'deduction',
        quantity: null,
        rate: b.employee_rate,
        amount,
        taxable: false,
        bpjs_base: false,
        legal_basis: b.wage_cap ? `상한 ${b.wage_cap.toLocaleString('id-ID')}` : null,
        sort_order: 100,
      });
    }

    // --- PPh 21 ------------------------------------------------------------
    const category = terCategory(e.ptkp_status);
    if (!category) {
      warnings.push('PTKP 구분이 없어 소득세를 계산할 수 없습니다.');
    } else {
      const band = input.taxBands.find(
        (b) =>
          b.category === category &&
          taxableGross >= b.lower_bound &&
          (b.upper_bound === null || taxableGross <= b.upper_bound)
      );
      if (!band) {
        warnings.push(`세율표에 ${category} 구분의 해당 구간이 없습니다.`);
      } else if (band.rate > 0) {
        lines.push({
          component_code: 'PPH21',
          component_name: `PPh 21 (TER ${category})`,
          kind: 'deduction',
          quantity: null,
          rate: band.rate,
          amount: roundLine(taxableGross * band.rate),
          taxable: false,
          bpjs_base: false,
          legal_basis: 'PMK 168/2023',
          sort_order: 110,
        });
      }
    }

    // --- Loan deductions ---------------------------------------------------
    const beforeLoans =
      gross - lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0);
    const loanCap = beforeLoans * (policy.max_loan_deduction_rate / 100);
    let loanTaken = 0;

    for (const loan of loansByEmployee.get(e.id) ?? []) {
      const room = Math.max(0, loanCap - loanTaken);
      const amount = roundLine(Math.min(loan.amount, room));
      if (amount < loan.amount) {
        warnings.push(
          `${loan.lender_name} 공제가 실지급 ${policy.max_loan_deduction_rate}% 상한에 걸려 ${loan.amount.toLocaleString('id-ID')} 중 ${amount.toLocaleString('id-ID')} 만 공제했습니다.`
        );
      }
      if (amount <= 0) continue;
      loanTaken += amount;
      lines.push({
        component_code: 'LOAN',
        component_name: `대출 상환 (${loan.lender_name})`,
        kind: 'deduction',
        quantity: null,
        rate: null,
        amount,
        taxable: false,
        bpjs_base: false,
        legal_basis: null,
        sort_order: 120,
      });
    }

    // --- Totals ------------------------------------------------------------
    const deductionTotal = lines
      .filter((l) => l.kind === 'deduction')
      .reduce((s, l) => s + l.amount, 0);
    let net = gross - deductionTotal;
    if (policy.rounding_scope === 'total') net = roundTo(net, policy.rounding_unit);

    if (net < 0) warnings.push('실지급액이 음수입니다.');

    // The minimum wage applies to the base wage, not to what lands in the
    // account after deductions.
    const umk = e.umk_region ? input.umkByRegion.get(e.umk_region) : undefined;
    if (e.umk_region && umk === undefined) {
      warnings.push(`${e.umk_region} 지역의 UMK가 등록되어 있지 않습니다.`);
    } else if (umk !== undefined && factor >= 1 && e.base_salary < umk) {
      warnings.push(
        `기본급이 ${e.umk_region} UMK ${umk.toLocaleString('id-ID')} 에 미달합니다.`
      );
    }

    results.push({
      employee_id: e.id,
      employee_no: e.employee_no,
      employee_name: e.full_name,
      department_id: e.department_id,
      position_id: e.position_id,
      base_salary: e.base_salary,
      ptkp_status: e.ptkp_status,
      work_days: workDays,
      ot_minutes: otMinutes,
      gross,
      taxable_gross: taxableGross,
      bpjs_base: bpjsBase,
      deduction_total: deductionTotal,
      net,
      lines: lines.sort((a, b) => a.sort_order - b.sort_order),
      otLines,
      warnings,
    });
  }

  return {
    results,
    gross_total: results.reduce((s, r) => s + r.gross, 0),
    deduction_total: results.reduce((s, r) => s + r.deduction_total, 0),
    net_total: results.reduce((s, r) => s + r.net, 0),
  };
}

/**
 * A stable fingerprint of a computed run.
 *
 * Only the figures go in, in a fixed order — not timestamps or ids that differ
 * between passes. Two runs over the same inputs must produce the same string,
 * or G2 has found something that is not deterministic.
 */
export function batchHash(output: EngineOutput): string {
  const parts: string[] = [];
  for (const r of [...output.results].sort((a, b) => a.employee_no.localeCompare(b.employee_no))) {
    parts.push(
      [
        r.employee_no,
        r.gross,
        r.taxable_gross,
        r.bpjs_base,
        r.deduction_total,
        r.net,
        ...r.lines.map((l) => `${l.component_code}:${l.amount}`),
      ].join('|')
    );
  }
  return fnv1a(parts.join('\n'));
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Two rounds over the same data, so a short hash still separates runs that
  // differ only late in the string.
  let g = 0x811c9dc5;
  for (let i = text.length - 1; i >= 0; i--) {
    g ^= text.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0');
}
