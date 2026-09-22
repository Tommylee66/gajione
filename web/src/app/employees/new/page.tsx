import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { listDepartments, listPositions } from '@/lib/data-access/org';
import { EmployeeForm } from '@/components/employee-form';

export default async function NewEmployeePage() {
  const session = await getSession();
  if (!session) redirect('/login');
  // Repeated here as well as in the action: the action is the enforcement,
  // this just avoids showing a form that cannot be submitted.
  if (session.role !== 'hr_admin' && session.role !== 'operator_admin') redirect('/employees');

  const supabase = await createClient();
  const [departments, positions, company] = await Promise.all([
    listDepartments(supabase),
    listPositions(supabase),
    supabase.from('companies').select('umk_region').maybeSingle(),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <Link href="/employees" className="text-sm text-blue-600 underline">
        ← 직원 목록
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">직원 등록</h1>
      <EmployeeForm
        departments={departments}
        positions={positions}
        defaultUmkRegion={company.data?.umk_region ?? null}
      />
    </main>
  );
}
