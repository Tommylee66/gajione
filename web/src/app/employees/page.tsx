import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession, canSeeSensitive } from '@/lib/auth/session';
import { listEmployees } from '@/lib/data-access/employees';
import { listDepartments } from '@/lib/data-access/org';
import { formatRupiah, formatDate, employmentLabel } from '@/lib/format';

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; dept?: string; resigned?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { q, dept, resigned } = await searchParams;
  const supabase = await createClient();

  const [employees, departments] = await Promise.all([
    listEmployees(supabase, session, {
      search: q,
      departmentId: dept,
      includeResigned: resigned === '1',
    }),
    listDepartments(supabase),
  ]);

  const showSalary = canSeeSensitive(session.role);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">직원 마스터</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {employees.length}명
            {resigned === '1' ? ' (퇴사자 포함)' : ''}
          </p>
        </div>
        <Link
          href="/employees/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
        >
          직원 등록
        </Link>
      </header>

      {/* A GET form so a filtered list is a URL someone can bookmark or send. */}
      <form className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-neutral-500" htmlFor="q">
            이름 · 사번
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-neutral-500" htmlFor="dept">
            부서
          </label>
          <select
            id="dept"
            name="dept"
            defaultValue={dept ?? ''}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">전체</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" name="resigned" value="1" defaultChecked={resigned === '1'} />
          퇴사자 포함
        </label>
        <button className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700">
          조회
        </button>
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">사번</th>
              <th className="px-3 py-2 font-medium">이름</th>
              <th className="px-3 py-2 font-medium">부서</th>
              <th className="px-3 py-2 font-medium">직급</th>
              <th className="px-3 py-2 font-medium">고용형태</th>
              <th className="px-3 py-2 font-medium">입사일</th>
              {/* The column is absent, not blanked, for roles that may not see
                  it — an empty cell invites someone to go looking for the value. */}
              {showSalary && <th className="px-3 py-2 text-right font-medium">기본급</th>}
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">
                  <Link href={`/employees/${e.id}`} className="text-blue-600 underline">
                    {e.employee_no}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {e.full_name}
                  {e.resign_date && (
                    <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      퇴사
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{e.department_name ?? '—'}</td>
                <td className="px-3 py-2">{e.position_name ?? '—'}</td>
                <td className="px-3 py-2">{employmentLabel(e.employment_type)}</td>
                <td className="px-3 py-2">{formatDate(e.join_date)}</td>
                {showSalary && (
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatRupiah(e.base_salary)}
                  </td>
                )}
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={showSalary ? 7 : 6} className="px-3 py-10 text-center text-neutral-500">
                  조건에 맞는 직원이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
