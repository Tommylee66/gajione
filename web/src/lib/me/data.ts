import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';

/**
 * What the employee app reads about the signed-in worker.
 *
 * Every query here is scoped by RLS to current_employee_id(), so none carries
 * a filter of its own beyond what the screen needs. The value of that is not
 * brevity: a bug in this file cannot leak a colleague's row, because the
 * database refuses before the code gets a chance.
 */
export async function requireMe() {
  const session = await requireSession();
  if (!session.employee_id) throw new Error('직원 계정이 아닙니다.');
  return session;
}

export interface MeProfile {
  employee_no: string;
  full_name: string;
  department: string | null;
  position: string | null;
  employer: string | null;
  employment_type: string;
  join_date: string | null;
  base_salary: number;
}

export async function loadProfile(): Promise<MeProfile | null> {
  const session = await requireMe();
  const supabase = await createClient();
  const { data: e } = await supabase
    .from('employees')
    .select('employee_no, full_name, department_id, position_id, employment_type, join_date, base_salary')
    .eq('id', session.employee_id)
    .maybeSingle();
  if (!e) return null;

  const [deptRes, posRes, coRes] = await Promise.all([
    e.department_id
      ? supabase.from('departments').select('name').eq('id', e.department_id as string).maybeSingle()
      : Promise.resolve({ data: null as { name?: string } | null }),
    e.position_id
      ? supabase.from('positions').select('name').eq('id', e.position_id as string).maybeSingle()
      : Promise.resolve({ data: null as { name?: string } | null }),
    supabase.from('companies').select('name').maybeSingle(),
  ]);

  return {
    employee_no: e.employee_no as string,
    full_name: e.full_name as string,
    department: (deptRes.data?.name as string | undefined) ?? null,
    position: (posRes.data?.name as string | undefined) ?? null,
    employer: (coRes.data?.name as string | undefined) ?? null,
    employment_type: e.employment_type as string,
    join_date: (e.join_date as string | null) ?? null,
    base_salary: Number(e.base_salary ?? 0),
  };
}
