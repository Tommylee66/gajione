/**
 * Parser for the punch export a fingerprint terminal produces.
 *
 * Expected columns, header row required:
 *   employee_no,punched_at,direction,device_code
 *   MF-0341,2026-08-19 07:58:00,in,FP-01
 *
 * Written rather than pulled in as a dependency because the format is ours and
 * the failure mode matters more than the feature set: a payroll import that
 * silently drops the rows it could not read is worse than one that refuses the
 * file. Every rejected line comes back with its number and the reason.
 */

export interface PunchRow {
  lineNo: number;
  employeeNo: string;
  punchedAt: string; // ISO 8601
  direction: 'in' | 'out';
  deviceCode: string | null;
}

export interface ParseError {
  lineNo: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  rows: PunchRow[];
  errors: ParseError[];
  totalLines: number;
}

const REQUIRED = ['employee_no', 'punched_at', 'direction'] as const;

/** Splits one CSV line, honouring double quotes around a field. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Terminals export local time without a zone. Interpreting that as UTC would
 * shift every punch by seven hours and turn a 07:58 arrival into a late one,
 * so the offset is applied explicitly.
 *
 * WIB (UTC+7) covers Jakarta and Bekasi. A customer in WITA or WIT needs this
 * to come from their company record instead — noted rather than guessed.
 */
const DEFAULT_UTC_OFFSET = '+07:00';

function toIso(value: string, offset: string): string | null {
  const v = value.trim().replace('T', ' ');
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ ]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${s ?? '00'}${offset}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function parsePunchCsv(text: string, utcOffset = DEFAULT_UTC_OFFSET): ParseResult {
  // A BOM on the first header cell is the usual reason "employee_no" is not
  // recognised in a file exported from Excel.
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');

  if (lines.length === 0) {
    return { rows: [], errors: [{ lineNo: 0, raw: '', reason: '빈 파일입니다.' }], totalLines: 0 };
  }

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          lineNo: 1,
          raw: lines[0],
          reason: `필수 컬럼이 없습니다: ${missing.join(', ')}`,
        },
      ],
      totalLines: lines.length - 1,
    };
  }

  const idx = {
    employeeNo: header.indexOf('employee_no'),
    punchedAt: header.indexOf('punched_at'),
    direction: header.indexOf('direction'),
    deviceCode: header.indexOf('device_code'),
  };

  const rows: PunchRow[] = [];
  const errors: ParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cells = splitLine(lines[i]);

    const employeeNo = cells[idx.employeeNo] ?? '';
    if (!employeeNo) {
      errors.push({ lineNo, raw: lines[i], reason: '사번이 비어 있습니다.' });
      continue;
    }

    const punchedAt = toIso(cells[idx.punchedAt] ?? '', utcOffset);
    if (!punchedAt) {
      errors.push({
        lineNo,
        raw: lines[i],
        reason: `시각 형식을 읽을 수 없습니다 (YYYY-MM-DD HH:MM[:SS]): "${cells[idx.punchedAt] ?? ''}"`,
      });
      continue;
    }

    const rawDirection = (cells[idx.direction] ?? '').toLowerCase();
    const direction =
      rawDirection === 'in' || rawDirection === '출근'
        ? 'in'
        : rawDirection === 'out' || rawDirection === '퇴근'
          ? 'out'
          : null;
    if (!direction) {
      errors.push({
        lineNo,
        raw: lines[i],
        reason: `in 또는 out 이어야 합니다: "${cells[idx.direction] ?? ''}"`,
      });
      continue;
    }

    rows.push({
      lineNo,
      employeeNo,
      punchedAt,
      direction,
      deviceCode: idx.deviceCode >= 0 ? (cells[idx.deviceCode] || null) : null,
    });
  }

  return { rows, errors, totalLines: lines.length - 1 };
}

export const PUNCH_CSV_TEMPLATE = `employee_no,punched_at,direction,device_code
MF-0341,2026-08-19 07:58:00,in,FP-01
MF-0341,2026-08-19 17:05:00,out,FP-01
MF-0512,2026-08-19 19:55:00,in,FP-07
MF-0512,2026-08-20 04:10:00,out,FP-07
`;
