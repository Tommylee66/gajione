/**
 * The PPh 21 source-data template: 43 columns, parsed and validated.
 *
 * Pure, so the same file always produces the same verdict. A row rejected on
 * upload has to be rejectable again with the same reason when somebody
 * disputes it a month later.
 */

/** The 43 columns, in template order. Renaming or reordering one breaks every file already in the field. */
export const TEMPLATE_COLUMNS = [
  'employee_number',
  'employment_status',
  'employee_name',
  'employee_npwp',
  'employee_nik',
  'ptkp_category',
  'tax_method',
  'gross_salary',
  'position_allowance',
  'overtime_pay',
  'meal_allowance',
  'transport_allowance',
  'other_allowances',
  'natura_fasilitas_bkn_uang',
  'bonus',
  'THR',
  'pinjaman_gaji_loan_from_salary',
  'potong_gaji_deduction_from_salary',
  'jkk',
  'jkm',
  'jht_company',
  'jp_company',
  'bpjs_kesehatan_company',
  'jkp_company',
  'jht_employee',
  'jp_employee',
  'bpjs_kesehatan_employee',
  'jkp_employee',
  'position',
  'department',
  'join_date',
  'resign_date',
  'birth_date',
  'gender',
  'email',
  'phone',
  'address',
  'bank_name',
  'bank_account_no',
  'bank_account_name',
  'emergency_contact_name',
  'emergency_contact_phone',
  'notes',
] as const;

/** The eight the preview shows by default. The rest are behind "전체 43개 컬럼". */
export const CORE_COLUMNS = [
  'employee_number',
  'employee_name',
  'department',
  'position',
  'employment_status',
  'ptkp_category',
  'tax_method',
  'gross_salary',
] as const;

const NUMERIC_FIELDS = [
  'gross_salary',
  'position_allowance',
  'overtime_pay',
  'meal_allowance',
  'transport_allowance',
  'other_allowances',
  'natura_fasilitas_bkn_uang',
  'bonus',
  'THR',
  'pinjaman_gaji_loan_from_salary',
  'potong_gaji_deduction_from_salary',
  'jkk',
  'jkm',
  'jht_company',
  'jp_company',
  'bpjs_kesehatan_company',
  'jkp_company',
  'jht_employee',
  'jp_employee',
  'bpjs_kesehatan_employee',
  'jkp_employee',
];

const DATE_FIELDS = ['join_date', 'resign_date', 'birth_date'];

const VALID_EMPLOYMENT_STATUS = ['1', '2', '3'];
const VALID_PTKP = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'];
const VALID_TAX_METHOD = ['Gross', 'Gross Up', 'Nett'];

export type UploadRow = Record<string, string>;

export interface ParseResult {
  header: string[];
  rows: UploadRow[];
  /** Columns in the template that the file does not have. */
  missingColumns: string[];
  /** Columns in the file that the template does not know. */
  extraColumns: string[];
}

/**
 * CSV, quoted fields and embedded newlines included.
 *
 * Not a line-by-line split: an address field with a newline inside quotes is
 * ordinary in this template, and splitting on newlines first turns one
 * employee into two malformed rows.
 */
export function parseCsv(text: string): ParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) {
    return { header: [], rows: [], missingColumns: [...TEMPLATE_COLUMNS], extraColumns: [] };
  }

  const header = nonEmpty[0].map((h) => h.trim());
  const known = new Set<string>(TEMPLATE_COLUMNS);
  const present = new Set(header);

  const data = nonEmpty.slice(1).map((cells) => {
    const obj: UploadRow = {};
    header.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim();
    });
    return obj;
  });

  return {
    header,
    rows: data,
    missingColumns: TEMPLATE_COLUMNS.filter((c) => !present.has(c)),
    extraColumns: header.filter((h) => !known.has(h)),
  };
}

export interface RowVerdict {
  row_no: number;
  employee_number: string;
  data: UploadRow;
  errors: string[];
  warnings: string[];
}

export interface ValidateContext {
  /**
   * Minimum wage by region, for the floor check. Passed in rather than
   * hardcoded: the mockup's check is a fixed Bekasi figure, which is wrong
   * anywhere else and silently wrong when the figure changes.
   */
  umkByRegion: Map<string, number>;
  /** The company's own region, used when a row does not name one. */
  defaultRegion: string | null;
}

/**
 * Validates every row.
 *
 * Errors block the batch; warnings do not. The distinction matters because a
 * wage below the regional minimum is something a person has to look at, while
 * a missing employee number is a row that cannot be used at all.
 */
export function validateRows(rows: UploadRow[], ctx: ValidateContext): RowVerdict[] {
  const seen = new Set<string>();
  const out: RowVerdict[] = [];

  rows.forEach((row, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const empNo = (row.employee_number ?? '').trim();
    if (!empNo) errors.push('필수값 누락: employee_number');
    else if (seen.has(empNo)) errors.push(`중복된 employee_number: ${empNo}`);

    if (!(row.employee_name ?? '').trim()) errors.push('필수값 누락: employee_name');

    const status = (row.employment_status ?? '').trim();
    if (status && !VALID_EMPLOYMENT_STATUS.includes(status)) {
      errors.push('employment_status는 1/2/3 중 하나여야 합니다');
    }

    const ptkp = (row.ptkp_category ?? '').trim();
    if (ptkp && !VALID_PTKP.includes(ptkp)) errors.push(`ptkp_category 값 오류: ${ptkp}`);
    // Not an error, because PPh 21 cannot be computed without it and a blank
    // here becomes a wrong tax figure rather than a missing one.
    if (!ptkp) warnings.push('ptkp_category가 비어 있어 PPh 21을 계산할 수 없습니다');

    const method = (row.tax_method ?? '').trim();
    if (method && !VALID_TAX_METHOD.includes(method)) {
      errors.push('tax_method는 Gross / Gross Up / Nett 중 하나여야 합니다');
    }

    const gender = (row.gender ?? '').trim();
    if (gender && !['M', 'F'].includes(gender)) errors.push('gender는 M 또는 F여야 합니다');

    const grossRaw = (row.gross_salary ?? '').trim();
    const gross = Number(grossRaw);
    if (!grossRaw || Number.isNaN(gross)) {
      errors.push('gross_salary는 필수이며 숫자여야 합니다');
    } else if (gross <= 0) {
      errors.push('gross_salary는 0보다 커야 합니다');
    } else {
      const region = (row.department ?? '').trim() && ctx.umkByRegion.has((row.department ?? '').trim())
        ? (row.department ?? '').trim()
        : ctx.defaultRegion;
      const umk = region ? ctx.umkByRegion.get(region) : undefined;
      if (region && umk === undefined) {
        // A missing figure is worse than a low one: the check would otherwise
        // pass every row while testing nothing.
        warnings.push(`${region} 지역의 UMK가 등록되어 있지 않아 최저임금을 확인하지 못했습니다`);
      } else if (umk !== undefined && gross < umk) {
        warnings.push(`UMK 미달 (${region} ${umk.toLocaleString('id-ID')})`);
      }
    }

    for (const f of NUMERIC_FIELDS) {
      if (f === 'gross_salary') continue;
      const v = (row[f] ?? '').trim();
      if (v && Number.isNaN(Number(v))) errors.push(`${f} 값이 숫자가 아닙니다`);
    }

    const validDates = new Set<string>();
    for (const f of DATE_FIELDS) {
      const v = (row[f] ?? '').trim();
      if (!v) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        errors.push(`${f} 형식 오류 (YYYY-MM-DD 필요)`);
        continue;
      }
      // A date that parses as text but not as a day — 2026-02-30 — would
      // otherwise reach Postgres and fail the whole insert.
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        errors.push(`${f}는 존재하지 않는 날짜입니다: ${v}`);
        continue;
      }
      validDates.add(f);
    }

    // Only when both are real dates. Comparing two values already known to be
    // malformed invents a third reason that is not one, and the person fixing
    // the file then chases it.
    if (validDates.has('join_date') && validDates.has('resign_date')) {
      if ((row.resign_date ?? '').trim() < (row.join_date ?? '').trim()) {
        errors.push('resign_date가 join_date보다 빠릅니다');
      }
    }

    const email = (row.email ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      warnings.push(`email 형식이 올바르지 않습니다: ${email}`);
    }

    if (empNo) seen.add(empNo);
    out.push({ row_no: i + 1, employee_number: empNo, data: row, errors, warnings });
  });

  return out;
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The blank template, with one example row so the expected formats are visible. */
export function buildTemplateCsv(): string {
  const example: Record<string, string> = {
    employee_number: 'MF-0001',
    employment_status: '1',
    employee_name: 'Budi Santoso',
    employee_npwp: '12.345.678.9-012.000',
    employee_nik: '3216010101900001',
    ptkp_category: 'K/1',
    tax_method: 'Gross',
    gross_salary: '6500000',
    join_date: '2022-03-01',
    birth_date: '1990-01-01',
    gender: 'M',
    department: 'Bekasi',
    position: 'Operator',
  };
  return [
    TEMPLATE_COLUMNS.join(','),
    TEMPLATE_COLUMNS.map((c) => csvEscape(example[c] ?? '')).join(','),
  ].join('\n');
}

/** Only the rows that failed, each carrying its reasons, for fixing and re-uploading. */
export function buildErrorCsv(verdicts: RowVerdict[], header: string[]): string {
  const cols = header.length > 0 ? header : [...TEMPLATE_COLUMNS];
  const failed = verdicts.filter((v) => v.errors.length > 0);
  const lines = [[...cols, '오류사유'].map(csvEscape).join(',')];
  for (const v of failed) {
    lines.push([...cols.map((c) => csvEscape(v.data[c])), csvEscape(v.errors.join(' / '))].join(','));
  }
  return lines.join('\n');
}

export interface BatchSummary {
  total: number;
  ok: number;
  errors: number;
  warnings: number;
  canProceed: boolean;
}

export function summarise(verdicts: RowVerdict[]): BatchSummary {
  const errors = verdicts.filter((v) => v.errors.length > 0).length;
  return {
    total: verdicts.length,
    ok: verdicts.length - errors,
    errors,
    warnings: verdicts.filter((v) => v.warnings.length > 0).length,
    // An empty file is not a clean file.
    canProceed: verdicts.length > 0 && errors === 0,
  };
}
