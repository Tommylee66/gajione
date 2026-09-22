/**
 * Expands a repeating shift pattern over a date range.
 *
 * A three-group two-shift rotation is the same pattern applied to each group
 * with a different starting offset — group B starts two days into the cycle,
 * group C four days in. Storing it that way rather than as a per-day table
 * means a roster for a quarter is a few rows of configuration, not thousands
 * of decisions.
 */

/** One slot in the cycle: a shift id, or null for a rest day. */
export type PatternSlot = string | null;

export interface ExpandInput {
  employeeIds: string[];
  from: string; // 'YYYY-MM-DD'
  to: string;
  pattern: PatternSlot[];
  /** How far into the cycle this group starts. */
  offset: number;
  rotationGroup: string | null;
}

export interface ExpandedEntry {
  employee_id: string;
  work_date: string;
  shift_id: string | null;
  rotation_group: string | null;
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out;
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function expandPattern(input: ExpandInput): ExpandedEntry[] {
  const { employeeIds, from, to, pattern, offset, rotationGroup } = input;
  if (pattern.length === 0 || employeeIds.length === 0) return [];

  const dates = eachDate(from, to);
  const out: ExpandedEntry[] = [];

  for (const employeeId of employeeIds) {
    dates.forEach((work_date, i) => {
      // Anchored on the range start rather than a calendar epoch, so the
      // pattern a user previews is the pattern they get.
      const slot = pattern[(i + offset) % pattern.length];
      out.push({
        employee_id: employeeId,
        work_date,
        shift_id: slot,
        rotation_group: rotationGroup,
      });
    });
  }
  return out;
}

/** Rest days are stored as rows with a null shift, not as absent rows.
 * "Scheduled off" and "nobody rostered this person" look identical otherwise,
 * and G1 has to tell them apart: the first is fine, the second is a gap. */
export function summarisePattern(
  pattern: PatternSlot[],
  shiftNames: Map<string, string>
): string {
  if (pattern.length === 0) return '—';
  return pattern.map((s) => (s ? (shiftNames.get(s) ?? '?') : '휴무')).join(' · ');
}
