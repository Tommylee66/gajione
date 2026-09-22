/**
 * Reconciling overtime worked against overtime approved.
 *
 * The mockup makes "OT 사전승인 100%" a condition for closing G1, and the
 * word that matters is 사전 — before. An approval recorded after the shift is
 * not a control, it is paperwork, so the two cases are distinguished rather
 * than both counting as approved.
 */

export interface OtDay {
  employee_id: string;
  work_date: string;
  ot_minutes: number;
}

export interface OtRequestRow {
  id: string;
  employee_id: string;
  work_date: string;
  planned_minutes: number;
  actual_minutes: number | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approved_at: string | null;
  over_weekly_cap: boolean;
}

export interface OtGap {
  employee_id: string;
  work_date: string;
  worked_minutes: number;
  approved_minutes: number;
  /** Worked beyond what was approved. */
  unapproved_minutes: number;
  /** An approval exists but was recorded after the day it covers. */
  retroactive: boolean;
}

export function findOtGaps(days: OtDay[], requests: OtRequestRow[]): OtGap[] {
  const approvedByKey = new Map<string, OtRequestRow>();
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    approvedByKey.set(`${r.employee_id}|${r.work_date}`, r);
  }

  const gaps: OtGap[] = [];
  for (const d of days) {
    if (d.ot_minutes <= 0) continue;
    const key = `${d.employee_id}|${d.work_date}`;
    const request = approvedByKey.get(key);
    const approved = request ? (request.actual_minutes ?? request.planned_minutes) : 0;
    const unapproved = Math.max(0, d.ot_minutes - approved);
    // Compared against the end of the work day, so an approval signed that
    // same evening still counts as prior.
    const retroactive = Boolean(
      request?.approved_at && request.approved_at.slice(0, 10) > d.work_date
    );
    if (unapproved > 0 || retroactive) {
      gaps.push({
        employee_id: d.employee_id,
        work_date: d.work_date,
        worked_minutes: d.ot_minutes,
        approved_minutes: approved,
        unapproved_minutes: unapproved,
        retroactive,
      });
    }
  }
  return gaps.sort((a, b) => a.work_date.localeCompare(b.work_date));
}

/** Monday-based week key, which is how the statutory weekly cap is counted. */
export function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export interface WeeklyOverage {
  employee_id: string;
  week_start: string;
  minutes: number;
  cap_minutes: number;
}

/**
 * UU 13/2003 caps overtime at 18 hours a week. Exceeding it is not
 * automatically unlawful — it needs a specific approval — so this returns the
 * weeks that need one rather than treating them as errors.
 */
export function findWeeklyOverages(days: OtDay[], capMinutes = 1080): WeeklyOverage[] {
  const totals = new Map<string, number>();
  for (const d of days) {
    if (d.ot_minutes <= 0) continue;
    const key = `${d.employee_id}|${weekKey(d.work_date)}`;
    totals.set(key, (totals.get(key) ?? 0) + d.ot_minutes);
  }
  const out: WeeklyOverage[] = [];
  for (const [key, minutes] of totals) {
    if (minutes <= capMinutes) continue;
    const [employee_id, week_start] = key.split('|');
    out.push({ employee_id, week_start, minutes, cap_minutes: capMinutes });
  }
  return out.sort((a, b) => b.minutes - a.minutes);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}
