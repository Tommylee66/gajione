import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AppUser,
  Employee,
  EmployeeListRow,
  EmployeeSalaryHistoryEntry,
} from '@/types/domain';
import { applyEmployeeListMasking, applyEmployeeMasking, assertMasked } from '@/lib/masking/employee-masking';

/**
 * Every read goes through here and comes back already masked. The convention
 * is the same one bctcare uses: callers pass the viewer, not a role string,
 * and nothing downstream has to remember to hide anything.
 *
 * Tenant filtering is absent on purpose — RLS does it. Adding `.eq('company_id',
 * …)` here would look reassuring and would be the second place to forget when
 * a new query is written.
 */

export interface EmployeeFilter {
  search?: string;
  departmentId?: string;
  includeResigned?: boolean;
}

export async function listEmployees(
  supabase: SupabaseClient,
  viewer: AppUser,
  filter: EmployeeFilter = {}
): Promise<EmployeeListRow[]> {
  // No embedded select. PostgREST resolves `departments(name)` through the
  // foreign key, and this schema has none by design — so the names are looked
  // up separately and joined here. Every list view in this app has to do the
  // same; there is no shape of query that will work around it.
  let query = supabase.from('employees').select('*').order('employee_no');

  if (!filter.includeResigned) query = query.is('resign_date', null);
  if (filter.departmentId) query = query.eq('department_id', filter.departmentId);
  if (filter.search) {
    const term = `%${filter.search}%`;
    query = query.or(`full_name.ilike.${term},employee_no.ilike.${term}`);
  }

  const { data, error } = await query;
  if (error) throw error;

  const employees = (data ?? []) as Employee[];

  // Two small reads rather than one per row. Both tables are per-tenant and
  // short — a company has tens of departments, not thousands — so fetching
  // them whole and mapping in memory beats a second round trip per employee.
  const [departments, positions] = await Promise.all([
    supabase.from('departments').select('id, name'),
    supabase.from('positions').select('id, name'),
  ]);
  if (departments.error) throw departments.error;
  if (positions.error) throw positions.error;

  const deptNames = new Map((departments.data ?? []).map((d) => [d.id as string, d.name as string]));
  const posNames = new Map((positions.data ?? []).map((p) => [p.id as string, p.name as string]));

  const rows: EmployeeListRow[] = employees.map((e) => ({
    ...e,
    department_name: e.department_id ? (deptNames.get(e.department_id) ?? null) : null,
    position_name: e.position_id ? (posNames.get(e.position_id) ?? null) : null,
  }));

  const masked = applyEmployeeListMasking(rows, viewer);
  assertMasked(masked, viewer);
  return masked;
}

export async function getEmployee(
  supabase: SupabaseClient,
  id: string,
  viewer: AppUser
): Promise<Employee | null> {
  const { data, error } = await supabase.from('employees').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return applyEmployeeMasking(data as Employee, viewer);
}

/**
 * Unmasked. Server-internal only — the payroll engine needs the real salary,
 * and tax filing needs the real NPWP. Never hand the result to a client
 * component.
 */
export async function getEmployeeRaw(
  supabase: SupabaseClient,
  id: string
): Promise<Employee | null> {
  const { data, error } = await supabase.from('employees').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Employee) ?? null;
}

export interface CreateEmployeeInput {
  company_id: string;
  employee_no: string;
  full_name: string;
  nik?: string | null;
  npwp?: string | null;
  birth_date?: string | null;
  gender?: 'M' | 'F' | null;
  join_date: string;
  employment_type: Employee['employment_type'];
  department_id?: string | null;
  position_id?: string | null;
  base_salary: number;
  ptkp_status?: string | null;
  umk_region?: string | null;
}

export async function createEmployee(
  supabase: SupabaseClient,
  input: CreateEmployeeInput
): Promise<Employee> {
  const { data, error } = await supabase.from('employees').insert(input).select('*').single();
  if (error) throw error;
  return data as Employee;
}

export type UpdateEmployeeInput = Partial<Omit<CreateEmployeeInput, 'company_id'>>;

/**
 * updated_at is set here because there is no trigger to do it — see the
 * schema's conventions. Every writer in this codebase carries the same line.
 */
export async function updateEmployee(
  supabase: SupabaseClient,
  id: string,
  input: UpdateEmployeeInput
): Promise<Employee> {
  const { data, error } = await supabase
    .from('employees')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Employee;
}

/**
 * Salary changes are recorded, not just applied. G3's variance check reads
 * this, and "who approved the raise and when did it take effect" is a question
 * the current value alone cannot answer.
 *
 * Two writes with no transaction: the schema has no triggers, and PostgREST
 * gives us no transaction across calls. If the second fails the employee row
 * is already updated, so the history write comes first — an orphan history row
 * is a reconcilable discrepancy, a silent unrecorded raise is not.
 */
export async function changeSalary(
  supabase: SupabaseClient,
  employeeId: string,
  companyId: string,
  newAmount: number,
  effectiveDate: string,
  reason: string,
  approvedBy: string
): Promise<void> {
  const current = await getEmployeeRaw(supabase, employeeId);
  if (!current) throw new Error('Employee not found');

  const previous = current.base_salary;
  const changeRate = previous > 0 ? ((newAmount - previous) / previous) * 100 : null;

  const { error: historyError } = await supabase.from('employee_salary_history').insert({
    company_id: companyId,
    employee_id: employeeId,
    effective_date: effectiveDate,
    previous_amount: previous,
    new_amount: newAmount,
    change_rate: changeRate,
    reason,
    approved_by: approvedBy,
  });
  if (historyError) throw historyError;

  await updateEmployee(supabase, employeeId, { base_salary: newAmount });

  await supabase.rpc('log_audit', {
    p_action: 'EMPLOYEE_SALARY_CHANGED',
    p_target_table: 'employees',
    p_target_id: employeeId,
    p_details: { previous, new_amount: newAmount, effective_date: effectiveDate },
  });
}

export async function listSalaryHistory(
  supabase: SupabaseClient,
  employeeId: string
): Promise<EmployeeSalaryHistoryEntry[]> {
  const { data, error } = await supabase
    .from('employee_salary_history')
    .select('*')
    .eq('employee_id', employeeId)
    .order('effective_date', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmployeeSalaryHistoryEntry[];
}
