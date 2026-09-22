'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { parsePunchCsv, type ParseError } from '@/lib/attendance/csv';
import { buildDays, type ScheduleEntry } from '@/lib/attendance/build-days';
import {
  insertRawPunches,
  replaceDays,
  replaceAnomalies,
  listShifts,
  confirmDays,
} from '@/lib/data-access/attendance';

const EDIT_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];

async function requireAttendanceRole() {
  const session = await requireSession();
  if (!EDIT_ROLES.includes(session.role)) {
    throw new Error('Forbidden: 근태를 처리할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface UploadResult {
  ok: boolean;
  error?: string;
  parsedRows?: number;
  parseErrors?: ParseError[];
  unknownEmployees?: string[];
  inserted?: number;
  daysWritten?: number;
  daysSkippedConfirmed?: number;
  anomaliesFound?: number;
}

/**
 * Import is all-or-nothing on parsing. If any line fails to read, nothing is
 * written and every rejected line comes back with its number — a payroll
 * import that silently drops rows produces short paycheques that nobody
 * notices until the worker does.
 */
export async function uploadPunchesAction(
  csvText: string,
  from: string,
  to: string
): Promise<UploadResult> {
  try {
    const session = await requireAttendanceRole();
    const parsed = parsePunchCsv(csvText);

    if (parsed.errors.length > 0) {
      return {
        ok: false,
        error: `${parsed.errors.length}개 행을 읽지 못해 아무것도 저장하지 않았습니다.`,
        parsedRows: parsed.rows.length,
        parseErrors: parsed.errors.slice(0, 20),
      };
    }
    if (parsed.rows.length === 0) {
      return { ok: false, error: '읽을 수 있는 행이 없습니다.' };
    }

    const supabase = await createClient();

    // Employee numbers, not ids, are what a terminal exports. Resolving them
    // here rather than trusting the file is what catches a stale export from
    // before somebody joined.
    const employeeNos = [...new Set(parsed.rows.map((r) => r.employeeNo))];
    const { data: employees, error: empError } = await supabase
      .from('employees')
      .select('id, employee_no')
      .in('employee_no', employeeNos);
    if (empError) throw empError;

    const idByNo = new Map((employees ?? []).map((e) => [e.employee_no as string, e.id as string]));
    const unknown = employeeNos.filter((no) => !idByNo.has(no));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: '등록되지 않은 사번이 있어 저장하지 않았습니다.',
        unknownEmployees: unknown.slice(0, 20),
      };
    }

    const { data: devices } = await supabase.from('devices').select('id, code');
    const deviceByCode = new Map((devices ?? []).map((d) => [d.code as string, d.id as string]));

    const inserted = await insertRawPunches(
      supabase,
      session.company_id!,
      parsed.rows.map((r) => ({
        employee_id: idByNo.get(r.employeeNo)!,
        device_id: r.deviceCode ? (deviceByCode.get(r.deviceCode) ?? null) : null,
        punched_at: r.punchedAt,
        direction: r.direction,
        source: 'import',
      }))
    );

    // Terminals that sent punches in this file are, by definition, in sync.
    const seenDevices = [...new Set(parsed.rows.map((r) => r.deviceCode).filter(Boolean))] as string[];
    if (seenDevices.length > 0) {
      await supabase
        .from('devices')
        .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('code', seenDevices);
    }

    const rebuild = await rebuildRange(supabase, session.company_id!, from, to);

    await supabase.rpc('log_audit', {
      p_action: 'ATTENDANCE_IMPORTED',
      p_target_table: 'attendance_raw',
      p_target_id: `${from}~${to}`,
      p_details: { rows: inserted, days: rebuild.daysWritten, anomalies: rebuild.anomaliesFound },
    });

    revalidatePath('/attendance');
    return { ok: true, parsedRows: parsed.rows.length, inserted, ...rebuild };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '업로드에 실패했습니다.' };
  }
}

/** Re-derives day rows and anomalies for a range from the punches on file. */
async function rebuildRange(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  from: string,
  to: string
) {
  const [{ data: punches }, { data: schedules }, shifts, { data: leaves }] = await Promise.all([
    supabase
      .from('attendance_raw')
      .select('employee_id, punched_at, direction')
      .gte('punched_at', `${from}T00:00:00+07:00`)
      // A night shift starting on the last day of the range clocks out the
      // next morning, so the window reaches past the end date.
      .lte('punched_at', `${to}T23:59:59+07:00`),
    supabase
      .from('shift_schedules')
      .select('employee_id, work_date, shift_id')
      .gte('work_date', from)
      .lte('work_date', to),
    listShifts(supabase),
    supabase
      .from('leaves')
      .select('employee_id, start_date, end_date')
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from),
  ]);

  const leaveDays: { employee_id: string; work_date: string }[] = [];
  for (const l of (leaves ?? []) as { employee_id: string; start_date: string; end_date: string }[]) {
    for (let d = new Date(l.start_date); d <= new Date(l.end_date); d.setDate(d.getDate() + 1)) {
      leaveDays.push({ employee_id: l.employee_id, work_date: d.toISOString().slice(0, 10) });
    }
  }

  const built = buildDays(
    (punches ?? []) as { employee_id: string; punched_at: string; direction: 'in' | 'out' }[],
    (schedules ?? []) as ScheduleEntry[],
    shifts,
    leaveDays
  );

  const { written, skippedConfirmed } = await replaceDays(supabase, companyId, built.days);
  const anomaliesFound = await replaceAnomalies(supabase, companyId, built.anomalies, from, to);

  return { daysWritten: written, daysSkippedConfirmed: skippedConfirmed, anomaliesFound };
}

export async function rebuildRangeAction(from: string, to: string): Promise<UploadResult> {
  try {
    const session = await requireAttendanceRole();
    const supabase = await createClient();
    const result = await rebuildRange(supabase, session.company_id!, from, to);
    revalidatePath('/attendance');
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '재집계에 실패했습니다.' };
  }
}

export interface SimpleResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolving an anomaly records what was decided and why. The mockup's own
 * examples are all of this shape — "지문기#7 로그 보정 · CCTV 교차확인" — and
 * the reason is the whole value of the record.
 */
export async function resolveAnomalyAction(
  id: string,
  resolution: string,
  waive: boolean
): Promise<SimpleResult> {
  try {
    const session = await requireAttendanceRole();
    if (!resolution.trim()) return { ok: false, error: '처리 내용을 입력하세요.' };

    const supabase = await createClient();
    const { error } = await supabase
      .from('attendance_anomalies')
      .update({
        resolution,
        status: waive ? 'waived' : 'resolved',
        resolved_by: session.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'ATTENDANCE_ANOMALY_RESOLVED',
      p_target_table: 'attendance_anomalies',
      p_target_id: id,
      p_details: { resolution, waived: waive },
    });

    revalidatePath('/attendance');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * Closing G1. Refuses while anomalies are open, because confirmed attendance
 * is what payroll computes from and an unexplained gap becomes a wrong
 * paycheque rather than a question.
 */
export async function confirmPeriodAction(from: string, to: string): Promise<SimpleResult> {
  try {
    await requireAttendanceRole();
    const supabase = await createClient();

    const { count, error: countError } = await supabase
      .from('attendance_anomalies')
      .select('id', { count: 'exact', head: true })
      .gte('work_date', from)
      .lte('work_date', to)
      .eq('status', 'open');
    if (countError) throw countError;

    if ((count ?? 0) > 0) {
      return { ok: false, error: `미해결 이상근태 ${count}건이 남아 있어 마감할 수 없습니다.` };
    }

    const confirmed = await confirmDays(supabase, from, to);
    await supabase.rpc('log_audit', {
      p_action: 'ATTENDANCE_PERIOD_CONFIRMED',
      p_target_table: 'attendance_days',
      p_target_id: `${from}~${to}`,
      p_details: { confirmed },
    });

    revalidatePath('/attendance');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '마감에 실패했습니다.' };
  }
}
