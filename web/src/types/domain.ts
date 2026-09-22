/**
 * Hand-written to mirror supabase/migrations/*.sql. `supabase gen types` needs
 * a container runtime that is not always available here, and the schema has no
 * foreign keys for it to infer relationships from anyway — so these are
 * maintained alongside the migrations whenever one changes.
 */

export type UserRole =
  | 'operator_admin'
  | 'hr_admin'
  | 'payroll_staff'
  | 'line_manager'
  | 'employee'
  | 'lender_officer';

export type EmploymentType = 'permanent' | 'contract' | 'probation' | 'daily' | 'intern';

export interface AppUser {
  id: string;
  email: string | null;
  full_name: string;
  role: UserRole;
  /** null for GajiOne operators — they are not scoped to a tenant. */
  company_id: string | null;
  /** Set for the employee app, so a worker's login maps to their own record. */
  employee_id: string | null;
  lender_id: string | null;
  is_active: boolean;
  is_approved: boolean;
}

export interface Company {
  id: string;
  name: string;
  industry: string | null;
  npwp: string | null;
  nib: string | null;
  address: string | null;
  umk_region: string | null;
  status: 'active' | 'suspended' | 'closed';
  joined_at: string;
}

export interface Department {
  id: string;
  company_id: string;
  code: string;
  name: string;
  parent_id: string | null;
  active: boolean;
}

export interface Position {
  id: string;
  company_id: string;
  name: string;
  grade_level: number | null;
  /** Indonesian practice excludes managerial grades from overtime. */
  ot_eligible: boolean;
  active: boolean;
}

export interface Employee {
  id: string;
  company_id: string;
  employee_no: string;
  full_name: string;
  /** KTP. Specific personal data under UU PDP — masked below hr_admin. */
  nik: string | null;
  npwp: string | null;
  birth_date: string | null;
  gender: 'M' | 'F' | null;
  join_date: string;
  resign_date: string | null;
  employment_type: EmploymentType;
  department_id: string | null;
  position_id: string | null;
  /** Specific personal data (financial). Masked below hr_admin. */
  base_salary: number;
  ptkp_status: string | null;
  umk_region: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** The list view joins names in rather than making the table resolve ids. */
export interface EmployeeListRow extends Employee {
  department_name: string | null;
  position_name: string | null;
}

export interface EmployeeBankAccount {
  id: string;
  company_id: string;
  employee_id: string;
  bank_name: string;
  /** Ciphertext, never the digits. Only the last 4 reach a list view. */
  account_number_encrypted: { iv: string; authTag: string; ciphertext: string } | null;
  account_number_last4: string | null;
  holder_name: string | null;
  is_primary: boolean;
}

export interface EmployeeSalaryHistoryEntry {
  id: string;
  company_id: string;
  employee_id: string;
  effective_date: string;
  previous_amount: number | null;
  new_amount: number;
  change_rate: number | null;
  reason: string | null;
  approved_by: string | null;
  created_at: string;
}
