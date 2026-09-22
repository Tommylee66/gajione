import type { Employee, EmployeeListRow } from '@/types/domain';
import type { AppUser } from '@/types/domain';

/**
 * Field-level masking, applied in the data-access layer and nowhere else.
 *
 * RLS decides which rows a caller gets; it cannot restrict columns. NIK, base
 * salary and bank details are specific personal data under UU PDP art. 4, and
 * a payroll clerk needs to work with an employee record without reading their
 * national ID number.
 *
 * Masking here rather than in a component means the unmasked value never
 * reaches the browser — not in the HTML, not in a serialised server-component
 * payload, not in devtools.
 */

/** Last four digits only: enough to check against a physical document. */
export function maskNik(nik: string | null): string | null {
  if (!nik) return null;
  const digits = nik.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return '************' + digits.slice(-4);
}

export function maskNpwp(npwp: string | null): string | null {
  if (!npwp) return null;
  const digits = npwp.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return '****...' + digits.slice(-4);
}

/**
 * Salary is hidden outright rather than bucketed. A range would still leak a
 * colleague's pay band, and unlike a cost figure there is no operational need
 * for an approximation — you either administer payroll or you do not.
 */
export const SALARY_HIDDEN = null;

export function applyEmployeeMasking<T extends Employee>(employee: T, viewer: AppUser): T {
  if (viewer.role === 'operator_admin' || viewer.role === 'hr_admin') return employee;

  // An employee always sees their own record in full.
  if (viewer.employee_id && viewer.employee_id === employee.id) return employee;

  return {
    ...employee,
    nik: maskNik(employee.nik),
    npwp: maskNpwp(employee.npwp),
    base_salary: NaN,
  };
}

export function applyEmployeeListMasking(
  rows: EmployeeListRow[],
  viewer: AppUser
): EmployeeListRow[] {
  return rows.map((r) => applyEmployeeMasking(r, viewer));
}

/**
 * Build-time safety net: throws if a value that should have been masked is
 * about to be handed to a caller. Cheap, and it fails loudly during
 * development rather than quietly in production.
 */
export function assertMasked(rows: Employee[], viewer: AppUser): void {
  if (viewer.role === 'operator_admin' || viewer.role === 'hr_admin') return;
  for (const r of rows) {
    if (viewer.employee_id === r.id) continue;
    if (r.nik && !r.nik.startsWith('*')) {
      throw new Error(`Unmasked NIK leaked for employee ${r.id}`);
    }
    if (Number.isFinite(r.base_salary)) {
      throw new Error(`Unmasked salary leaked for employee ${r.id}`);
    }
  }
}
