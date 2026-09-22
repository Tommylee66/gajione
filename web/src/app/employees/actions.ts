'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { createEmployee, updateEmployee, changeSalary } from '@/lib/data-access/employees';

/**
 * Master data is hr_admin's to change. payroll_staff runs payroll against it
 * and must not edit it — the two duties are separated on purpose, since
 * whoever can both raise a salary and approve the run can pay themselves.
 */
async function requireHrAdmin() {
  const session = await requireSession();
  if (session.role !== 'hr_admin' && session.role !== 'operator_admin') {
    throw new Error('Forbidden: 인사 마스터를 변경할 권한이 없습니다.');
  }
  if (!session.company_id) {
    throw new Error('회사가 지정되지 않은 계정입니다.');
  }
  return session;
}

const nullableText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const employeeSchema = z.object({
  employee_no: z.string().trim().min(1, '사번을 입력하세요.'),
  full_name: z.string().trim().min(1, '이름을 입력하세요.'),
  // NIK is 16 digits. Checked because a typo here follows the person through
  // every tax filing they appear in.
  nik: nullableText.refine((v) => v === null || /^\d{16}$/.test(v), 'NIK는 숫자 16자리입니다.'),
  npwp: nullableText,
  birth_date: nullableText,
  gender: z.enum(['M', 'F']).nullable(),
  join_date: z.string().min(1, '입사일을 입력하세요.'),
  employment_type: z.enum(['permanent', 'contract', 'probation', 'daily', 'intern']),
  department_id: nullableText,
  position_id: nullableText,
  ptkp_status: nullableText,
  umk_region: nullableText,
});

export type EmployeeFormValues = z.input<typeof employeeSchema> & { base_salary?: number };

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export async function createEmployeeAction(
  raw: EmployeeFormValues & { base_salary: number }
): Promise<ActionResult> {
  try {
    const session = await requireHrAdmin();
    const parsed = employeeSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }
    if (!Number.isFinite(raw.base_salary) || raw.base_salary < 0) {
      return { ok: false, error: '기본급을 확인하세요.' };
    }

    const supabase = await createClient();
    const employee = await createEmployee(supabase, {
      ...parsed.data,
      company_id: session.company_id!,
      base_salary: raw.base_salary,
    });

    await supabase.rpc('log_audit', {
      p_action: 'EMPLOYEE_CREATED',
      p_target_table: 'employees',
      p_target_id: employee.id,
      p_details: { employee_no: employee.employee_no },
    });

    revalidatePath('/employees');
    return { ok: true, id: employee.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '등록에 실패했습니다.' };
  }
}

/**
 * base_salary is absent here on purpose. Changing pay writes a history row
 * that G3's variance check reads, so it goes through changeSalaryAction and
 * cannot be done as a quiet field edit.
 */
export async function updateEmployeeAction(
  id: string,
  raw: EmployeeFormValues
): Promise<ActionResult> {
  try {
    await requireHrAdmin();
    const parsed = employeeSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }

    const supabase = await createClient();
    await updateEmployee(supabase, id, parsed.data);

    await supabase.rpc('log_audit', {
      p_action: 'EMPLOYEE_UPDATED',
      p_target_table: 'employees',
      p_target_id: id,
      p_details: { employee_no: parsed.data.employee_no },
    });

    revalidatePath('/employees');
    revalidatePath(`/employees/${id}`);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '수정에 실패했습니다.' };
  }
}

const salarySchema = z.object({
  new_amount: z.number().finite().min(0, '금액을 확인하세요.'),
  effective_date: z.string().min(1, '효력일을 입력하세요.'),
  reason: z.string().trim().min(1, '사유를 입력하세요.'),
});

export async function changeSalaryAction(
  employeeId: string,
  raw: { new_amount: number; effective_date: string; reason: string }
): Promise<ActionResult> {
  try {
    const session = await requireHrAdmin();
    const parsed = salarySchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' };
    }

    const supabase = await createClient();
    await changeSalary(
      supabase,
      employeeId,
      session.company_id!,
      parsed.data.new_amount,
      parsed.data.effective_date,
      parsed.data.reason,
      session.id
    );

    revalidatePath('/employees');
    revalidatePath(`/employees/${employeeId}`);
    return { ok: true, id: employeeId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '급여 변경에 실패했습니다.' };
  }
}

export async function setResignDateAction(
  id: string,
  resignDate: string | null
): Promise<ActionResult> {
  try {
    await requireHrAdmin();
    const supabase = await createClient();

    // The row stays. Past payroll runs, tax filings and deduction mandates all
    // name it, and each has its own retention period measured in years.
    await updateEmployee(supabase, id, {});
    const { error } = await supabase
      .from('employees')
      .update({ resign_date: resignDate, is_active: resignDate === null, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: resignDate ? 'EMPLOYEE_RESIGNED' : 'EMPLOYEE_REINSTATED',
      p_target_table: 'employees',
      p_target_id: id,
      p_details: { resign_date: resignDate },
    });

    revalidatePath('/employees');
    revalidatePath(`/employees/${id}`);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}
