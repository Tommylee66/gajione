import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { findOtGaps, findWeeklyOverages, type OtRequestRow } from '@/lib/attendance/overtime';
import { OvertimePanel, type EmployeeLite } from '@/components/overtime-panel';

function periodRange(period: string) {
  const [y, m] = period.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 2, 26)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m - 1, 25)).toISOString().slice(0, 10),
  };
}

export default async function OvertimePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { period = '2026-08' } = await searchParams;
  const { from, to } = periodRange(period);
  const supabase = await createClient();

  const [daysRes, requestRes, employeeRes, policyRes] = await Promise.all([
    supabase
      .from('attendance_days')
      .select('employee_id, work_date, ot_minutes')
      .gte('work_date', from)
      .lte('work_date', to)
      .gt('ot_minutes', 0),
    supabase
      .from('ot_requests')
      .select('*')
      .gte('work_date', from)
      .lte('work_date', to)
      .order('work_date', { ascending: false }),
    supabase
      .from('employees')
      .select('id, employee_no, full_name')
      .is('resign_date', null)
      .order('employee_no'),
    supabase.from('payroll_policies').select('weekly_ot_cap_minutes').maybeSingle(),
  ]);

  const days = daysRes.data ?? [];
  const requests = (requestRes.data ?? []) as OtRequestRow[];
  const cap = policyRes.data?.weekly_ot_cap_minutes ?? 1080;

  const gaps = findOtGaps(days, requests);
  // A week already covered by a special approval is not reported again.
  const flagged = new Set(
    requests.filter((r) => r.over_weekly_cap).map((r) => r.employee_id)
  );
  const overages = findWeeklyOverages(days, cap).filter((o) => !flagged.has(o.employee_id));

  const canEdit = ['hr_admin', 'payroll_staff', 'operator_admin', 'line_manager'].includes(
    session.role
  );
  const canApprove = ['hr_admin', 'operator_admin', 'line_manager'].includes(session.role);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="flex gap-4 text-sm">
        <Link href="/attendance" className="text-blue-600 underline">
          ← 근태 마감
        </Link>
        <Link href="/shifts" className="text-blue-600 underline">
          교대 · 스케줄
        </Link>
      </div>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">초과근무 사전승인</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {period} 차수 · {from} ~ {to}
          </p>
        </div>
        <form className="flex items-end gap-2">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">차수</span>
            <input
              type="month"
              name="period"
              defaultValue={period}
              className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700">
            조회
          </button>
        </form>
      </header>

      <OvertimePanel
        from={from}
        to={to}
        employees={(employeeRes.data ?? []) as EmployeeLite[]}
        requests={requests}
        gaps={gaps}
        overages={overages}
        canEdit={canEdit}
        canApprove={canApprove}
      />
    </main>
  );
}
