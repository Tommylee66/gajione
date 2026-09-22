/**
 * The report catalogue.
 *
 * Eight categories, each with a per-run export, a date-range query and an
 * annual total. Declared as data rather than as twenty-four hand-written
 * screens so a new report is a row here, and so the screen and the generator
 * cannot disagree about what exists.
 */

export type ReportScope = 'period' | 'range' | 'annual';

export interface ReportDef {
  id: string;
  category: CategoryId;
  scope: ReportScope;
  name: string;
  description: string;
  /** Columns, in output order. The generator returns rows keyed by these. */
  columns: string[];
}

export type CategoryId =
  | 'payslip'
  | 'tax'
  | 'bpjs'
  | 'hr'
  | 'attendance'
  | 'expense'
  | 'overtime'
  | 'loan';

export interface CategoryDef {
  id: CategoryId;
  name: string;
  description: string;
  /**
   * Set when nothing in the system produces this data yet. A reporting surface
   * over a table that does not exist is a report of nothing, and shipping it
   * silently would have somebody downloading an empty file and concluding the
   * month was quiet.
   */
  unavailable?: string;
}

export const CATEGORIES: CategoryDef[] = [
  { id: 'payslip', name: '급여명세 리포트', description: '급여명세서 데이터' },
  { id: 'tax', name: '세금 리포트', description: 'PPh 21 원천징수 · e-Bupot 연동' },
  { id: 'bpjs', name: 'BPJS 리포트', description: 'BPJS 기여금 · SIPP 연동' },
  { id: 'hr', name: '인사 리포트', description: '인원 현황 · 입퇴사 · 직급/부서 구성' },
  { id: 'attendance', name: '근태 리포트', description: '출퇴근 기록 · 지각·결근 이상' },
  {
    id: 'expense',
    name: '실비정산 리포트',
    description: '실비정산 청구 내역',
    unavailable:
      '실비정산 청구를 입력하는 화면과 테이블이 아직 없습니다. 만들어지면 이 리포트가 열립니다.',
  },
  { id: 'overtime', name: '초과근무 리포트', description: '초과근무 시간 · 수당' },
  { id: 'loan', name: '대출 리포트', description: '대출·EWA 잔액 · 상환' },
];

const EMPLOYEE_COLS = ['employee_no', 'employee_name', 'department'];

export const REPORTS: ReportDef[] = [
  // --- 급여명세 -------------------------------------------------------------
  {
    id: 'payslip_period',
    category: 'payslip',
    scope: 'period',
    name: '급여명세 (차수)',
    description: '선택한 차수의 직원별 지급·공제·실지급',
    columns: [...EMPLOYEE_COLS, 'work_days', 'ot_hours', 'gross', 'deduction_total', 'net'],
  },
  {
    id: 'payslip_range',
    category: 'payslip',
    scope: 'range',
    name: '급여명세 (기간)',
    description: '기간 내 전 차수 통합 급여명세',
    columns: ['period', 'run_type', ...EMPLOYEE_COLS, 'gross', 'deduction_total', 'net'],
  },
  {
    id: 'payslip_annual',
    category: 'payslip',
    scope: 'annual',
    name: '급여명세 연간',
    description: '연간 누적 지급·공제·실지급 (THR·상여 포함)',
    columns: [...EMPLOYEE_COLS, 'runs', 'gross_total', 'deduction_total', 'net_total'],
  },

  // --- 세금 -----------------------------------------------------------------
  {
    id: 'tax_period',
    category: 'tax',
    scope: 'period',
    name: 'PPh 21 (차수)',
    description: '차수별 PPh 21 원천징수 내역 · e-Bupot 대사용',
    columns: [...EMPLOYEE_COLS, 'npwp', 'ptkp_status', 'taxable_gross', 'pph21'],
  },
  {
    id: 'tax_range',
    category: 'tax',
    scope: 'range',
    name: 'PPh 21 (기간)',
    description: '기간 내 직원별 PPh 21 원천징수 상세',
    columns: ['period', ...EMPLOYEE_COLS, 'taxable_gross', 'pph21'],
  },
  {
    id: 'tax_annual',
    category: 'tax',
    scope: 'annual',
    name: 'PPh 21 연간',
    description: '연간 누적 PPh 21 · SPT Tahunan 대사용',
    columns: [...EMPLOYEE_COLS, 'npwp', 'ptkp_status', 'taxable_gross_total', 'pph21_total'],
  },

  // --- BPJS -----------------------------------------------------------------
  {
    id: 'bpjs_period',
    category: 'bpjs',
    scope: 'period',
    name: 'BPJS (차수)',
    description: '차수별 프로그램별 기여금 · SIPP 대사용',
    columns: [...EMPLOYEE_COLS, 'bpjs_base', 'kesehatan', 'jht', 'jp', 'employee_total'],
  },
  {
    id: 'bpjs_range',
    category: 'bpjs',
    scope: 'range',
    name: 'BPJS (기간)',
    description: '기간 내 직원별 BPJS 기여금 상세',
    columns: ['period', ...EMPLOYEE_COLS, 'employee_total'],
  },
  {
    id: 'bpjs_annual',
    category: 'bpjs',
    scope: 'annual',
    name: 'BPJS 연간',
    description: '연간 누적 기여금 (직원 부담분)',
    columns: [...EMPLOYEE_COLS, 'kesehatan_total', 'jht_total', 'jp_total', 'employee_total'],
  },

  // --- 인사 -----------------------------------------------------------------
  {
    id: 'hr_period',
    category: 'hr',
    scope: 'period',
    name: '인사 현황 (차수)',
    description: '차수 기준 재직자 명부 · 부서·직급 구성',
    columns: [
      'employee_no',
      'employee_name',
      'department',
      'position',
      'employment_type',
      'join_date',
      'ptkp_status',
      'base_salary',
    ],
  },
  {
    id: 'hr_range',
    category: 'hr',
    scope: 'range',
    name: '입퇴사 (기간)',
    description: '기간 내 입사·퇴사 이력',
    columns: ['event', 'event_date', 'employee_no', 'employee_name', 'department', 'employment_type'],
  },
  {
    id: 'hr_annual',
    category: 'hr',
    scope: 'annual',
    name: '인력 현황 연간',
    description: '연간 월별 입사·퇴사·재직 추이',
    columns: ['month', 'joined', 'resigned', 'headcount_end'],
  },

  // --- 근태 -----------------------------------------------------------------
  {
    id: 'attendance_period',
    category: 'attendance',
    scope: 'period',
    name: '근태 (차수)',
    description: '차수 컷오프 구간의 일자별 근태',
    columns: [
      ...EMPLOYEE_COLS,
      'work_date',
      'check_in',
      'check_out',
      'late_minutes',
      'ot_minutes',
      'status',
    ],
  },
  {
    id: 'attendance_range',
    category: 'attendance',
    scope: 'range',
    name: '근태 (기간)',
    description: '기간 내 전체 근태 및 예외 건',
    columns: [...EMPLOYEE_COLS, 'work_date', 'late_minutes', 'ot_minutes', 'status'],
  },
  {
    id: 'attendance_annual',
    category: 'attendance',
    scope: 'annual',
    name: '근태 연간',
    description: '연간 부서별 지각·결근 집계',
    columns: ['department', 'days', 'late_days', 'absent_days', 'late_rate_percent'],
  },

  // --- 실비정산 -------------------------------------------------------------
  // Declared so the catalogue matches the mockup and the refusal is a real,
  // testable path rather than a report that simply is not there. The category
  // carries the reason; the generator reads it and refuses.
  {
    id: 'expense_period',
    category: 'expense',
    scope: 'period',
    name: '실비정산 (차수)',
    description: '차수별 실비정산 청구·승인 내역',
    columns: [...EMPLOYEE_COLS, 'claim_date', 'claim_type', 'amount', 'status'],
  },
  {
    id: 'expense_range',
    category: 'expense',
    scope: 'range',
    name: '실비정산 (기간)',
    description: '기간 내 전체 실비정산 청구 이력',
    columns: [...EMPLOYEE_COLS, 'claim_date', 'claim_type', 'amount', 'status'],
  },
  {
    id: 'expense_annual',
    category: 'expense',
    scope: 'annual',
    name: '실비정산 연간',
    description: '연간 항목별 실비정산 누적',
    columns: ['claim_type', 'claims', 'amount_total'],
  },

  // --- 초과근무 -------------------------------------------------------------
  {
    id: 'overtime_period',
    category: 'overtime',
    scope: 'period',
    name: '초과근무 (차수)',
    description: '차수별 직원 초과근무 시간과 수당',
    columns: [...EMPLOYEE_COLS, 'ot_hours', 'ot_amount'],
  },
  {
    id: 'overtime_range',
    category: 'overtime',
    scope: 'range',
    name: '초과근무 승인 (기간)',
    description: '기간 내 OT 사전승인 신청·승인 이력',
    columns: [
      ...EMPLOYEE_COLS,
      'work_date',
      'planned_minutes',
      'actual_minutes',
      'over_weekly_cap',
      'status',
    ],
  },
  {
    id: 'overtime_annual',
    category: 'overtime',
    scope: 'annual',
    name: '초과근무 연간',
    description: '연간 직원별 초과근무 누적',
    columns: [...EMPLOYEE_COLS, 'ot_hours_total', 'ot_amount_total'],
  },

  // --- 대출 -----------------------------------------------------------------
  {
    id: 'loan_period',
    category: 'loan',
    scope: 'period',
    name: '대출 공제 (차수)',
    description: '차수별 급여공제 집행 내역',
    columns: [...EMPLOYEE_COLS, 'lender', 'lender_ref_no', 'installment_no', 'amount', 'status'],
  },
  {
    id: 'loan_range',
    category: 'loan',
    scope: 'range',
    name: '대출 취급 (기간)',
    description: '기간 내 신청·전달·승인 이력',
    columns: [
      ...EMPLOYEE_COLS,
      'lender',
      'product',
      'amount_requested',
      'months',
      'score_snapshot',
      'status',
      'created_at',
    ],
  },
  {
    id: 'loan_annual',
    category: 'loan',
    scope: 'annual',
    name: '대출 잔액 연간',
    description: '연간 공제 누적과 현재 잔액 (잔액은 금융기관 원장 사본)',
    columns: [...EMPLOYEE_COLS, 'lender', 'deducted_total', 'balance', 'synced_at'],
  },
];

export function reportsFor(category: CategoryId): ReportDef[] {
  return REPORTS.filter((r) => r.category === category);
}

export function findReport(id: string): ReportDef | undefined {
  return REPORTS.find((r) => r.id === id);
}

export type ReportRow = Record<string, string | number | null>;

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to CSV, columns in the definition's order.
 *
 * Keyed by column name rather than positional, so adding a column to a report
 * cannot silently shift every value in the file one place to the left.
 */
export function toCsv(def: ReportDef, rows: ReportRow[]): string {
  return [
    def.columns.join(','),
    ...rows.map((r) => def.columns.map((c) => csvEscape(r[c])).join(',')),
  ].join('\n');
}

export function reportFilename(def: ReportDef, label: string): string {
  return `${def.id}_${label}.csv`.replace(/[^\w.\-]/g, '_');
}
