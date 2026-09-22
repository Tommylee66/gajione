'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  createDepartment,
  updateDepartment,
  createPosition,
  updatePosition,
} from '@/lib/data-access/org';

async function requireHrAdmin() {
  const session = await requireSession();
  if (session.role !== 'hr_admin' && session.role !== 'operator_admin') {
    throw new Error('Forbidden: 조직 정보를 변경할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const departmentSchema = z.object({
  code: z.string().trim().min(1, '코드를 입력하세요.').max(40),
  name: z.string().trim().min(1, '부서명을 입력하세요.'),
  parent_id: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

export async function createDepartmentAction(raw: {
  code: string;
  name: string;
  parent_id: string;
}): Promise<ActionResult> {
  try {
    const session = await requireHrAdmin();
    const parsed = departmentSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }
    const supabase = await createClient();
    const dept = await createDepartment(supabase, session.company_id!, parsed.data);
    await supabase.rpc('log_audit', {
      p_action: 'DEPARTMENT_CREATED',
      p_target_table: 'departments',
      p_target_id: dept.id,
      p_details: { code: dept.code, name: dept.name },
    });
    revalidatePath('/org');
    return { ok: true };
  } catch (e) {
    // The unique (company_id, code) constraint is the usual failure here.
    const message = e instanceof Error ? e.message : '';
    if (message.includes('duplicate key')) {
      return { ok: false, error: '이미 같은 코드의 부서가 있습니다.' };
    }
    return { ok: false, error: message || '등록에 실패했습니다.' };
  }
}

/**
 * Deactivation, not deletion.
 *
 * There are no foreign keys, so deleting a department would leave every
 * employee who belongs to it pointing at an id that no longer resolves — and
 * nothing in the database would object. The row would simply show a blank
 * department forever, and integrity_orphans would start reporting it.
 *
 * Deactivating keeps the reference intact and takes the option out of the
 * pickers, which is what "we do not use this line any more" actually means.
 */
export async function setDepartmentActiveAction(
  id: string,
  active: boolean
): Promise<ActionResult> {
  try {
    await requireHrAdmin();
    const supabase = await createClient();
    await updateDepartment(supabase, id, { active });
    await supabase.rpc('log_audit', {
      p_action: active ? 'DEPARTMENT_REACTIVATED' : 'DEPARTMENT_DEACTIVATED',
      p_target_table: 'departments',
      p_target_id: id,
      p_details: {},
    });
    revalidatePath('/org');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

const positionSchema = z.object({
  name: z.string().trim().min(1, '직급명을 입력하세요.'),
  grade_level: z.number().int().nullable(),
  ot_eligible: z.boolean(),
});

export async function createPositionAction(raw: {
  name: string;
  grade_level: number | null;
  ot_eligible: boolean;
}): Promise<ActionResult> {
  try {
    const session = await requireHrAdmin();
    const parsed = positionSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }
    const supabase = await createClient();
    const position = await createPosition(supabase, session.company_id!, parsed.data);
    await supabase.rpc('log_audit', {
      p_action: 'POSITION_CREATED',
      p_target_table: 'positions',
      p_target_id: position.id,
      p_details: { name: position.name, ot_eligible: position.ot_eligible },
    });
    revalidatePath('/org');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '등록에 실패했습니다.' };
  }
}

/**
 * Overtime eligibility is a pay rule, not a label — flipping it changes what
 * everyone on that grade is owed from the next run. Audited with both the old
 * and new value so the change can be tied to a period afterwards.
 */
export async function setPositionOtEligibleAction(
  id: string,
  otEligible: boolean
): Promise<ActionResult> {
  try {
    await requireHrAdmin();
    const supabase = await createClient();
    await updatePosition(supabase, id, { ot_eligible: otEligible });
    await supabase.rpc('log_audit', {
      p_action: 'POSITION_OT_ELIGIBILITY_CHANGED',
      p_target_table: 'positions',
      p_target_id: id,
      p_details: { ot_eligible: otEligible },
    });
    revalidatePath('/org');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

export async function setPositionActiveAction(id: string, active: boolean): Promise<ActionResult> {
  try {
    await requireHrAdmin();
    const supabase = await createClient();
    await updatePosition(supabase, id, { active });
    await supabase.rpc('log_audit', {
      p_action: active ? 'POSITION_REACTIVATED' : 'POSITION_DEACTIVATED',
      p_target_table: 'positions',
      p_target_id: id,
      p_details: {},
    });
    revalidatePath('/org');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}
