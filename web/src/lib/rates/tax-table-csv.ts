/**
 * Parser for a PPh 21 TER schedule.
 *
 * Expected columns, header row required:
 *   category,lower_bound,upper_bound,rate
 *   A,0,5400000,0
 *   A,5400001,5650000,0.0025
 *
 * rate is a fraction (0.0025), not a percentage, because that is what the
 * calculation multiplies by and converting on the way in is one fewer place
 * to be wrong by a factor of 100.
 *
 * The table decides what every employee takes home, so this validates the
 * shape rather than trusting the file: bands must start at zero, must not
 * overlap, must not leave gaps, and exactly one band per category may be
 * open-ended. A schedule with a hole in it would compute tax of zero for
 * anyone who lands in it.
 */

export interface TaxBand {
  category: string;
  lower_bound: number;
  upper_bound: number | null;
  rate: number;
}

export interface TaxParseError {
  lineNo: number;
  reason: string;
}

export interface TaxParseResult {
  bands: TaxBand[];
  errors: TaxParseError[];
  categories: string[];
}

function splitLine(line: string): string[] {
  return line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
}

/**
 * Money. Indonesian exports write 5.400.000, so dots that group thousands are
 * stripped — but only here, never for a rate.
 */
function toAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '').replace(/\.(?=\d{3}\b)/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * A rate, parsed strictly.
 *
 * Running it through the amount parser turns 0.005 into 0005 — the dot is
 * followed by exactly three digits, which is what a thousands separator looks
 * like. The value then reads as 5, trips the "written in percent" guard, and
 * the band is rejected. Three of twelve bands in a real schedule hit this,
 * which is the sort of near miss that would otherwise have shipped: the two
 * columns have different notation and cannot share a parser.
 */
function toRate(raw: string): number | null {
  const cleaned = raw.replace(/[\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseTaxTableCsv(text: string): TaxParseResult {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { bands: [], errors: [{ lineNo: 0, reason: '빈 파일입니다.' }], categories: [] };
  }

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const required = ['category', 'lower_bound', 'rate'];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      bands: [],
      errors: [{ lineNo: 1, reason: `필수 컬럼이 없습니다: ${missing.join(', ')}` }],
      categories: [],
    };
  }

  const idx = {
    category: header.indexOf('category'),
    lower: header.indexOf('lower_bound'),
    upper: header.indexOf('upper_bound'),
    rate: header.indexOf('rate'),
  };

  const bands: TaxBand[] = [];
  const errors: TaxParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cells = splitLine(lines[i]);

    const category = (cells[idx.category] ?? '').toUpperCase();
    if (!category) {
      errors.push({ lineNo, reason: '구분(category)이 비어 있습니다.' });
      continue;
    }

    const lower = toAmount(cells[idx.lower] ?? '');
    if (lower === null || lower < 0) {
      errors.push({ lineNo, reason: `하한을 읽을 수 없습니다: "${cells[idx.lower] ?? ''}"` });
      continue;
    }

    const upperRaw = idx.upper >= 0 ? (cells[idx.upper] ?? '') : '';
    const upper = upperRaw === '' ? null : toAmount(upperRaw);
    if (upperRaw !== '' && upper === null) {
      errors.push({ lineNo, reason: `상한을 읽을 수 없습니다: "${upperRaw}"` });
      continue;
    }
    if (upper !== null && upper <= lower) {
      errors.push({ lineNo, reason: `상한이 하한보다 작거나 같습니다 (${lower} ~ ${upper}).` });
      continue;
    }

    const rate = toRate(cells[idx.rate] ?? '');
    if (rate === null || rate < 0) {
      errors.push({ lineNo, reason: `세율을 읽을 수 없습니다: "${cells[idx.rate] ?? ''}"` });
      continue;
    }
    // A schedule written in percent would put 5 where 0.05 belongs and
    // withhold five times the tax. Rejected rather than guessed at.
    if (rate > 1) {
      errors.push({
        lineNo,
        reason: `세율은 비율로 입력합니다 (5% → 0.05). 받은 값: ${rate}`,
      });
      continue;
    }

    bands.push({ category, lower_bound: lower, upper_bound: upper, rate });
  }

  const categories = [...new Set(bands.map((b) => b.category))].sort();
  if (errors.length === 0) {
    errors.push(...validateCoverage(bands, categories));
  }

  return { bands, errors, categories };
}

/** Each category must tile the whole income range with no gaps or overlaps. */
function validateCoverage(bands: TaxBand[], categories: string[]): TaxParseError[] {
  const errors: TaxParseError[] = [];

  for (const category of categories) {
    const rows = bands
      .filter((b) => b.category === category)
      .sort((a, b) => a.lower_bound - b.lower_bound);

    if (rows.length === 0) continue;

    if (rows[0].lower_bound !== 0) {
      errors.push({
        lineNo: 0,
        reason: `${category} 구간이 0에서 시작하지 않습니다 (첫 하한 ${rows[0].lower_bound}).`,
      });
    }

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      if (prev.upper_bound === null) {
        errors.push({
          lineNo: 0,
          reason: `${category}에 상한 없는 구간이 마지막이 아닙니다 (하한 ${prev.lower_bound}).`,
        });
        break;
      }
      // Bands are written inclusive, so the next lower bound should be the
      // previous upper plus one rupiah.
      if (curr.lower_bound > prev.upper_bound + 1) {
        errors.push({
          lineNo: 0,
          reason: `${category}에 빈 구간이 있습니다 (${prev.upper_bound} ~ ${curr.lower_bound}).`,
        });
      } else if (curr.lower_bound <= prev.upper_bound) {
        errors.push({
          lineNo: 0,
          reason: `${category} 구간이 겹칩니다 (${curr.lower_bound} ≤ ${prev.upper_bound}).`,
        });
      }
    }

    if (rows[rows.length - 1].upper_bound !== null) {
      errors.push({
        lineNo: 0,
        reason: `${category}의 마지막 구간에 상한이 있습니다. 최고 구간은 상한을 비워 주세요.`,
      });
    }
  }

  return errors;
}

/** Looks up the effective rate for a monthly gross. Used by G2 and by the
 * upload screen's preview, so the number shown is the number that will be
 * withheld. */
export function findRate(bands: TaxBand[], category: string, monthlyGross: number): number | null {
  const band = bands.find(
    (b) =>
      b.category === category &&
      monthlyGross >= b.lower_bound &&
      (b.upper_bound === null || monthlyGross <= b.upper_bound)
  );
  return band ? band.rate : null;
}

export const TAX_TABLE_TEMPLATE = `category,lower_bound,upper_bound,rate
A,0,5400000,0
A,5400001,5650000,0.0025
A,5650001,,0.05
B,0,6200000,0
B,6200001,,0.0025
C,0,6600000,0
C,6600001,,0.0025
`;
