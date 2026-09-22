import type { SupabaseClient } from '@supabase/supabase-js';
import type { Department, Position } from '@/types/domain';

export async function listDepartments(supabase: SupabaseClient): Promise<Department[]> {
  const { data, error } = await supabase
    .from('departments')
    .select('*')
    .eq('active', true)
    .order('code');
  if (error) throw error;
  return (data ?? []) as Department[];
}

export async function listPositions(supabase: SupabaseClient): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('active', true)
    .order('grade_level', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Position[];
}

/** Headcount per department and position, so the management screen can say
 * what is in use before anyone deactivates something. */
export interface OrgUsage {
  byDepartment: Map<string, number>;
  byPosition: Map<string, number>;
}

export async function getOrgUsage(supabase: SupabaseClient): Promise<OrgUsage> {
  // One read, counted here. A per-row count query would be tens of round trips
  // for a screen that shows tens of rows.
  const { data, error } = await supabase
    .from('employees')
    .select('department_id, position_id')
    .is('resign_date', null);
  if (error) throw error;

  const byDepartment = new Map<string, number>();
  const byPosition = new Map<string, number>();
  for (const row of (data ?? []) as { department_id: string | null; position_id: string | null }[]) {
    if (row.department_id) byDepartment.set(row.department_id, (byDepartment.get(row.department_id) ?? 0) + 1);
    if (row.position_id) byPosition.set(row.position_id, (byPosition.get(row.position_id) ?? 0) + 1);
  }
  return { byDepartment, byPosition };
}

/** Includes inactive rows — the management screen has to show what it can
 * reactivate, and an employee may still point at a deactivated department. */
export async function listAllDepartments(supabase: SupabaseClient): Promise<Department[]> {
  const { data, error } = await supabase.from('departments').select('*').order('code');
  if (error) throw error;
  return (data ?? []) as Department[];
}

export async function listAllPositions(supabase: SupabaseClient): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .order('grade_level', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Position[];
}

export interface DepartmentInput {
  code: string;
  name: string;
  parent_id: string | null;
}

export async function createDepartment(
  supabase: SupabaseClient,
  companyId: string,
  input: DepartmentInput
): Promise<Department> {
  const { data, error } = await supabase
    .from('departments')
    .insert({ ...input, company_id: companyId })
    .select('*')
    .single();
  if (error) throw error;
  return data as Department;
}

export async function updateDepartment(
  supabase: SupabaseClient,
  id: string,
  input: Partial<DepartmentInput> & { active?: boolean }
): Promise<void> {
  // updated_at by hand: the schema has no triggers.
  const { error } = await supabase
    .from('departments')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export interface PositionInput {
  name: string;
  grade_level: number | null;
  ot_eligible: boolean;
}

export async function createPosition(
  supabase: SupabaseClient,
  companyId: string,
  input: PositionInput
): Promise<Position> {
  const { data, error } = await supabase
    .from('positions')
    .insert({ ...input, company_id: companyId })
    .select('*')
    .single();
  if (error) throw error;
  return data as Position;
}

export async function updatePosition(
  supabase: SupabaseClient,
  id: string,
  input: Partial<PositionInput> & { active?: boolean }
): Promise<void> {
  const { error } = await supabase
    .from('positions')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
