'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { expandPattern, type PatternSlot } from '@/lib/attendance/rotation';

const EDIT_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];

async function requireShiftRole() {
  const session = await requireSession();
  if (!EDIT_ROLES.includes(session.role)) {
    throw new Error('Forbidden: 교대·스케줄을 변경할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  assigned?: number;
  skippedConfirmed?: number;
}

const shiftSchema = z
  .object({
    name: z.string().trim().min(1, '교대명을 입력하세요.'),
    start_time: z.string().regex(/^\d{2}:\d{2}$/, '시작 시각을 확인하세요.'),
    end_time: z.string().regex(/^\d{2}:\d{2}$/, '종료 시각을 확인하세요.'),
    break_minutes: z.number().int().min(0).max(480),
    is_night: z.boolean(),
  })
  .transform((v) => ({
    ...v,
    start_time: `${v.start_time}:00`,
    end_time: `${v.end_time}:00`,
    // Derived, not asked. A shift whose end is at or before its start runs
    // past midnight by definition, and making the user tick a box for
    // something the times already say invites the two to disagree.
    crosses_midnight: v.end_time <= v.start_time,
  }));

export async function createShiftAction(raw: {
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  is_night: boolean;
}): Promise<ActionResult> {
  try {
    const session = await requireShiftRole();
    const parsed = shiftSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('shifts')
      .insert({ ...parsed.data, company_id: session.company_id })
      .select('id')
      .single();
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'SHIFT_CREATED',
      p_target_table: 'shifts',
      p_target_id: data.id,
      p_details: parsed.data,
    });
    revalidatePath('/shifts');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '등록에 실패했습니다.' };
  }
}

export async function setShiftActiveAction(id: string, active: boolean): Promise<ActionResult> {
  try {
    await requireShiftRole();
    const supabase = await createClient();
    const { error } = await supabase
      .from('shifts')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    revalidatePath('/shifts');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

export interface AssignInput {
  employeeIds: string[];
  from: string;
  to: string;
  pattern: PatternSlot[];
  offset: number;
  rotationGroup: string | null;
}

/**
 * Writes a roster over a range.
 *
 * Days whose attendance has already been confirmed are left alone. The
 * schedule is what the day builder measured lateness and overtime against, so
 * moving it under a closed period would silently change figures payroll has
 * already read — and nothing would say so.
 */
export async function assignScheduleAction(input: AssignInput): Promise<ActionResult> {
  try {
    const session = await requireShiftRole();
    if (input.employeeIds.length === 0) return { ok: false, error: '직원을 선택하세요.' };
    if (input.pattern.length === 0) return { ok: false, error: '패턴을 한 칸 이상 지정하세요.' };
    if (!input.from || !input.to || input.to < input.from) {
      return { ok: false, error: '기간을 확인하세요.' };
    }

    const entries = expandPattern(input);
    if (entries.length === 0) return { ok: false, error: '생성된 스케줄이 없습니다.' };
    if (entries.length > 20000) {
      return { ok: false, error: '한 번에 배정할 수 있는 범위를 넘었습니다. 기간을 나눠 주세요.' };
    }

    const supabase = await createClient();

    const { data: confirmed, error: confirmedError } = await supabase
      .from('attendance_days')
      .select('employee_id, work_date')
      .eq('is_confirmed', true)
      .gte('work_date', input.from)
      .lte('work_date', input.to)
      .in('employee_id', input.employeeIds);
    if (confirmedError) throw confirmedError;

    const locked = new Set((confirmed ?? []).map((c) => `${c.employee_id}|${c.work_date}`));
    const writable = entries.filter((e) => !locked.has(`${e.employee_id}|${e.work_date}`));

    const CHUNK = 500;
    for (let i = 0; i < writable.length; i += CHUNK) {
      const slice = writable
        .slice(i, i + CHUNK)
        .map((e) => ({ ...e, company_id: session.company_id }));
      const { error } = await supabase
        .from('shift_schedules')
        .upsert(slice, { onConflict: 'employee_id,work_date' });
      if (error) throw error;
    }

    await supabase.rpc('log_audit', {
      p_action: 'SHIFT_SCHEDULE_ASSIGNED',
      p_target_table: 'shift_schedules',
      p_target_id: `${input.from}~${input.to}`,
      p_details: {
        employees: input.employeeIds.length,
        days: writable.length,
        pattern_length: input.pattern.length,
        rotation_group: input.rotationGroup,
      },
    });

    revalidatePath('/shifts');
    revalidatePath('/attendance');
    return {
      ok: true,
      assigned: writable.length,
      skippedConfirmed: entries.length - writable.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '배정에 실패했습니다.' };
  }
}

export async function clearScheduleAction(
  employeeIds: string[],
  from: string,
  to: string
): Promise<ActionResult> {
  try {
    await requireShiftRole();
    const supabase = await createClient();

    const { data: confirmed } = await supabase
      .from('attendance_days')
      .select('employee_id, work_date')
      .eq('is_confirmed', true)
      .gte('work_date', from)
      .lte('work_date', to)
      .in('employee_id', employeeIds);

    if ((confirmed ?? []).length > 0) {
      return {
        ok: false,
        error: `마감된 근태가 ${confirmed!.length}건 있어 이 기간의 스케줄은 지울 수 없습니다.`,
      };
    }

    const { error } = await supabase
      .from('shift_schedules')
      .delete()
      .gte('work_date', from)
      .lte('work_date', to)
      .in('employee_id', employeeIds);
    if (error) throw error;

    revalidatePath('/shifts');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '삭제에 실패했습니다.' };
  }
}
