import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { ShiftManager, type ShiftRow, type EmployeeRow } from '@/components/shift-manager';

function defaultRange(period: string) {
  const [y, m] = period.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 2, 26)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m - 1, 25)).toISOString().slice(0, 10),
  };
}

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; dept?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { period = '2026-08', dept } = await searchParams;
  const { from, to } = defaultRange(period);
  const supabase = await createClient();

  let employeeQuery = supabase
    .from('employees')
    .select('id, employee_no, full_name, department_id, departments(name)')
    .is('resign_date', null)
    .order('employee_no');
  if (dept) employeeQuery = employeeQuery.eq('department_id', dept);

  const [shiftRes, employeeRes, scheduleRes, deptRes] = await Promise.all([
    supabase.from('shifts').select('*').order('start_time'),
    employeeQuery,
    supabase
      .from('shift_schedules')
      .select('employee_id, work_date, shift_id')
      .gte('work_date', from)
      .lte('work_date', to),
    supabase.from('departments').select('id, name').eq('active', true).order('code'),
  ]);

  type Joined = EmployeeRow & { departments: { name: string } | null };
  const employees: EmployeeRow[] = (employeeRes.data ?? []).map((row) => {
    const { departments, ...rest } = row as unknown as Joined;
    return { ...rest, department_name: departments?.name ?? null };
  });

  const canEdit = ['hr_admin', 'payroll_staff', 'operator_admin'].includes(session.role);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8">
      <Link href="/attendance" className="text-sm text-blue-600 underline">
        ← 근태 마감
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">교대 · 스케줄</h1>
          <p className="mt-1 text-sm text-neutral-500">{period} 차수 기준</p>
        </div>
        <form className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">차수</span>
            <input
              type="month"
              name="period"
              defaultValue={period}
              className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">부서</span>
            <select
              name="dept"
              defaultValue={dept ?? ''}
              className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            >
              <option value="">전체</option>
              {(deptRes.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700">
            조회
          </button>
        </form>
      </header>

      <ShiftManager
        shifts={(shiftRes.data ?? []) as ShiftRow[]}
        employees={employees}
        schedules={scheduleRes.data ?? []}
        from={from}
        to={to}
        canEdit={canEdit}
      />
    </main>
  );
}
