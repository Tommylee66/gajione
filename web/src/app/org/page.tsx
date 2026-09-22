import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { listAllDepartments, listAllPositions, getOrgUsage } from '@/lib/data-access/org';
import { OrgManager } from '@/components/org-manager';

export default async function OrgPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const supabase = await createClient();
  const [departments, positions, usage] = await Promise.all([
    listAllDepartments(supabase),
    listAllPositions(supabase),
    getOrgUsage(supabase),
  ]);

  const canEdit = session.role === 'hr_admin' || session.role === 'operator_admin';

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <Link href="/employees" className="text-sm text-blue-600 underline">
        ← 직원 목록
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">조직 관리</h1>
      <p className="mt-1 text-sm text-neutral-500">부서·라인과 직급을 관리합니다.</p>

      <OrgManager
        departments={departments}
        positions={positions}
        // Maps do not survive the server-to-client boundary; plain objects do.
        deptUsage={Object.fromEntries(usage.byDepartment)}
        posUsage={Object.fromEntries(usage.byPosition)}
        canEdit={canEdit}
      />
    </main>
  );
}
