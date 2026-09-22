import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { getEmployeeRaw } from '@/lib/data-access/employees';
import { listDepartments, listPositions } from '@/lib/data-access/org';
import { EmployeeForm } from '@/components/employee-form';

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role !== 'hr_admin' && session.role !== 'operator_admin') redirect('/employees');

  const { id } = await params;
  const supabase = await createClient();

  // Raw rather than masked: only hr_admin reaches this page, and the form has
  // to round-trip the real NIK or saving would overwrite it with asterisks.
  const employee = await getEmployeeRaw(supabase, id);
  if (!employee) notFound();

  const [departments, positions] = await Promise.all([
    listDepartments(supabase),
    listPositions(supabase),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <Link href={`/employees/${id}`} className="text-sm text-blue-600 underline">
        ← {employee.full_name}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">직원 정보 수정</h1>
      <EmployeeForm departments={departments} positions={positions} employee={employee} />
    </main>
  );
}
