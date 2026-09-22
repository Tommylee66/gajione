import type { SupabaseClient } from '@supabase/supabase-js';
import type { BuiltAnomaly, BuiltDay, ShiftDef } from '@/lib/attendance/build-days';

export interface AttendanceDayRow {
  id: string;
  employee_id: string;
  work_date: string;
  check_in: string | null;
  check_out: string | null;
  work_minutes: number;
  late_minutes: number;
  early_leave_minutes: number;
  ot_minutes: number;
  status: string;
  is_confirmed: boolean;
  adjustment_reason: string | null;
}

export interface AnomalyRow {
  id: string;
  employee_id: string;
  work_date: string;
  anomaly_type: string;
  detail: string | null;
  resolution: string | null;
  status: 'open' | 'resolved' | 'waived';
  resolved_at: string | null;
}

export interface DeviceRow {
  id: string;
  code: string;
  name: string | null;
  last_sync_at: string | null;
  status: string;
}

export async function listDevices(supabase: SupabaseClient): Promise<DeviceRow[]> {
  const { data, error } = await supabase.from('devices').select('*').order('code');
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
}

export async function listShifts(supabase: SupabaseClient): Promise<Map<string, ShiftDef>> {
  const { data, error } = await supabase
    .from('shifts')
    .select('id, start_time, end_time, break_minutes, crosses_midnight')
    .eq('active', true);
  if (error) throw error;
  return new Map((data ?? []).map((s) => [s.id as string, s as ShiftDef]));
}

export async function listDaysInPeriod(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<AttendanceDayRow[]> {
  const { data, error } = await supabase
    .from('attendance_days')
    .select('*')
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date')
    .order('employee_id');
  if (error) throw error;
  return (data ?? []) as AttendanceDayRow[];
}

export async function listAnomalies(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<AnomalyRow[]> {
  const { data, error } = await supabase
    .from('attendance_anomalies')
    .select('*')
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date');
  if (error) throw error;
  return (data ?? []) as AnomalyRow[];
}

/**
 * Raw punches are append-only. Nothing in the application ever updates or
 * deletes one — a correction is made on the day row, with a reason, so the
 * original reading stays available to explain it.
 */
export async function insertRawPunches(
  supabase: SupabaseClient,
  companyId: string,
  rows: {
    employee_id: string;
    device_id: string | null;
    punched_at: string;
    direction: 'in' | 'out';
    source: string;
  }[]
): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunked: PostgREST has a request size limit, and a month of punches for a
  // few hundred people comfortably exceeds it.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({ ...r, company_id: companyId }));
    const { error } = await supabase.from('attendance_raw').insert(slice);
    if (error) throw error;
    inserted += slice.length;
  }
  return inserted;
}

/**
 * Day rows are rebuilt from the raw punches, so this replaces rather than
 * merges — except for days already confirmed, which are left alone. Once a
 * period's attendance is confirmed it is payroll's input and must not move
 * under it because somebody re-uploaded a file.
 */
export async function replaceDays(
  supabase: SupabaseClient,
  companyId: string,
  days: BuiltDay[]
): Promise<{ written: number; skippedConfirmed: number }> {
  if (days.length === 0) return { written: 0, skippedConfirmed: 0 };

  const dates = [...new Set(days.map((d) => d.work_date))].sort();
  const { data: existing, error: readError } = await supabase
    .from('attendance_days')
    .select('employee_id, work_date, is_confirmed')
    .gte('work_date', dates[0])
    .lte('work_date', dates[dates.length - 1]);
  if (readError) throw readError;

  const confirmed = new Set(
    (existing ?? [])
      .filter((e) => e.is_confirmed)
      .map((e) => `${e.employee_id}|${e.work_date}`)
  );

  const writable = days.filter((d) => !confirmed.has(`${d.employee_id}|${d.work_date}`));

  const CHUNK = 500;
  for (let i = 0; i < writable.length; i += CHUNK) {
    const slice = writable.slice(i, i + CHUNK).map((d) => ({ ...d, company_id: companyId }));
    // The unique (employee_id, work_date) constraint makes this an upsert
    // rather than a delete-then-insert, which would briefly leave the period
    // empty if the second half failed.
    const { error } = await supabase
      .from('attendance_days')
      .upsert(slice, { onConflict: 'employee_id,work_date' });
    if (error) throw error;
  }

  return { written: writable.length, skippedConfirmed: days.length - writable.length };
}

/**
 * Anomalies are replaced for the rebuilt range, but resolved ones survive: an
 * explanation someone wrote must not be erased by re-running the import.
 */
export async function replaceAnomalies(
  supabase: SupabaseClient,
  companyId: string,
  anomalies: BuiltAnomaly[],
  from: string,
  to: string
): Promise<number> {
  const { error: deleteError } = await supabase
    .from('attendance_anomalies')
    .delete()
    .gte('work_date', from)
    .lte('work_date', to)
    .eq('status', 'open');
  if (deleteError) throw deleteError;

  if (anomalies.length === 0) return 0;

  const { data: kept } = await supabase
    .from('attendance_anomalies')
    .select('employee_id, work_date, anomaly_type')
    .gte('work_date', from)
    .lte('work_date', to);
  const already = new Set(
    (kept ?? []).map((k) => `${k.employee_id}|${k.work_date}|${k.anomaly_type}`)
  );

  const fresh = anomalies
    .filter((a) => !already.has(`${a.employee_id}|${a.work_date}|${a.anomaly_type}`))
    .map((a) => ({ ...a, company_id: companyId }));

  if (fresh.length === 0) return 0;
  const { error } = await supabase.from('attendance_anomalies').insert(fresh);
  if (error) throw error;
  return fresh.length;
}

export async function confirmDays(
  supabase: SupabaseClient,
  from: string,
  to: string
): Promise<number> {
  const { data, error } = await supabase
    .from('attendance_days')
    .update({ is_confirmed: true, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .gte('work_date', from)
    .lte('work_date', to)
    .eq('is_confirmed', false)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}
