'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';

const EDIT_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin', 'line_manager'];
const APPROVE_ROLES = ['hr_admin', 'operator_admin', 'line_manager'];

async function requireOtRole(roles: string[]) {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw new Error('Forbidden: 초과근무를 처리할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  created?: number;
}

export async function createOtRequestsAction(input: {
  employeeIds: string[];
  workDate: string;
  plannedMinutes: number;
  reason: string;
}): Promise<ActionResult> {
  try {
    const session = await requireOtRole(EDIT_ROLES);
    if (input.employeeIds.length === 0) return { ok: false, error: '직원을 선택하세요.' };
    if (!input.workDate) return { ok: false, error: '근무일을 입력하세요.' };
    if (!Number.isFinite(input.plannedMinutes) || input.plannedMinutes <= 0) {
      return { ok: false, error: '예정 시간을 확인하세요.' };
    }
    if (!input.reason.trim()) return { ok: false, error: '사유를 입력하세요.' };

    const supabase = await createClient();

    // A day already covered is left alone rather than duplicated. Two
    // approvals for one shift would double the approved minutes and make the
    // gap report say overtime was covered when it was not.
    const { data: existing } = await supabase
      .from('ot_requests')
      .select('employee_id')
      .eq('work_date', input.workDate)
      .in('employee_id', input.employeeIds)
      .neq('status', 'cancelled');
    const already = new Set((existing ?? []).map((e) => e.employee_id as string));

    const rows = input.employeeIds
      .filter((id) => !already.has(id))
      .map((employee_id) => ({
        company_id: session.company_id,
        employee_id,
        work_date: input.workDate,
        planned_minutes: input.plannedMinutes,
        reason: input.reason,
        requested_by: session.id,
        status: 'pending' as const,
      }));

    if (rows.length === 0) {
      return { ok: false, error: '선택한 직원은 이미 해당 일자에 신청이 있습니다.' };
    }

    const { error } = await supabase.from('ot_requests').insert(rows);
    if (error) throw error;

    revalidatePath('/overtime');
    return { ok: true, created: rows.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '신청에 실패했습니다.' };
  }
}

/**
 * Approving records who and when. The timestamp is what lets the gap report
 * say an approval was signed after the shift it covers — which is the
 * difference between a control and a formality.
 */
export async function decideOtRequestAction(
  id: string,
  decision: 'approved' | 'rejected'
): Promise<ActionResult> {
  try {
    const session = await requireOtRole(APPROVE_ROLES);
    const supabase = await createClient();

    const { error } = await supabase
      .from('ot_requests')
      .update({
        status: decision,
        approved_by: session.id,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: decision === 'approved' ? 'OT_REQUEST_APPROVED' : 'OT_REQUEST_REJECTED',
      p_target_table: 'ot_requests',
      p_target_id: id,
      p_details: {},
    });

    revalidatePath('/overtime');
    revalidatePath('/attendance');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * Covers overtime that was worked without a prior request — the case the gap
 * report surfaces. Recorded as its own action so it is visible as an exception
 * rather than disappearing into the ordinary approval queue: the request is
 * created and approved in one step, dated today, which is exactly what makes
 * it show as retroactive.
 */
export async function approveRetroactivelyAction(input: {
  employeeId: string;
  workDate: string;
  minutes: number;
  reason: string;
}): Promise<ActionResult> {
  try {
    const session = await requireOtRole(APPROVE_ROLES);
    if (!input.reason.trim()) return { ok: false, error: '사후 승인 사유를 입력하세요.' };

    const supabase = await createClient();
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from('ot_requests')
      .select('id')
      .eq('work_date', input.workDate)
      .eq('employee_id', input.employeeId)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('ot_requests')
        .update({
          status: 'approved',
          actual_minutes: input.minutes,
          reason: input.reason,
          approved_by: session.id,
          approved_at: now,
          updated_at: now,
        })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('ot_requests').insert({
        company_id: session.company_id,
        employee_id: input.employeeId,
        work_date: input.workDate,
        planned_minutes: input.minutes,
        actual_minutes: input.minutes,
        reason: input.reason,
        requested_by: session.id,
        approved_by: session.id,
        approved_at: now,
        status: 'approved',
      });
      if (error) throw error;
    }

    await supabase.rpc('log_audit', {
      p_action: 'OT_APPROVED_RETROACTIVELY',
      p_target_table: 'ot_requests',
      p_target_id: `${input.employeeId}|${input.workDate}`,
      p_details: { minutes: input.minutes, reason: input.reason },
    });

    revalidatePath('/overtime');
    revalidatePath('/attendance');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/** Marks a week's overtime as covered by the special approval UU 13/2003
 * requires above 18 hours. */
export async function flagWeeklyCapAction(
  employeeId: string,
  from: string,
  to: string
): Promise<ActionResult> {
  try {
    await requireOtRole(APPROVE_ROLES);
    const supabase = await createClient();
    const { error } = await supabase
      .from('ot_requests')
      .update({ over_weekly_cap: true, updated_at: new Date().toISOString() })
      .eq('employee_id', employeeId)
      .gte('work_date', from)
      .lte('work_date', to);
    if (error) throw error;
    revalidatePath('/overtime');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}
