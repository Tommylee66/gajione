import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { listDevices, listDaysInPeriod, listAnomalies } from '@/lib/data-access/attendance';
import { evaluateG1 } from '@/lib/attendance/build-days';
import { AttendancePanel } from '@/components/attendance-panel';

/** Cut-off runs 26th to 25th by default (see payroll_policies); the period
 * label is the month it is paid in. */
function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 26));
  const end = new Date(Date.UTC(y, m - 1, 25));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { period = '2026-08' } = await searchParams;
  const { from, to } = periodRange(period);
  const supabase = await createClient();

  const [devices, days, anomalies, employees] = await Promise.all([
    listDevices(supabase),
    listDaysInPeriod(supabase, from, to),
    listAnomalies(supabase, from, to),
    supabase.from('employees').select('id, employee_no, full_name'),
  ]);

  const nameById = new Map(
    (employees.data ?? []).map((e) => [e.id as string, { no: e.employee_no as string, name: e.full_name as string }])
  );

  // A terminal counts as synced if it reported inside this period. Nothing has
  // reported for a month means nothing arrived, not that all is well.
  const synced = devices.filter(
    (d) => d.last_sync_at && d.last_sync_at >= `${from}T00:00:00`
  ).length;

  const otMinutes = days.reduce((s, d) => s + d.ot_minutes, 0);
  const { data: approvedOt } = await supabase
    .from('ot_requests')
    .select('actual_minutes, planned_minutes')
    .eq('status', 'approved')
    .gte('work_date', from)
    .lte('work_date', to);
  const approvedMinutes = (approvedOt ?? []).reduce(
    (s, r) => s + ((r.actual_minutes as number | null) ?? (r.planned_minutes as number)),
    0
  );

  const gate = evaluateG1({
    devicesTotal: devices.length,
    devicesSynced: synced,
    openAnomalies: anomalies.filter((a) => a.status === 'open').length,
    otMinutesWithoutApproval: Math.max(0, otMinutes - approvedMinutes),
    employeesOverWeeklyCap: 0,
  });

  const canEdit = ['hr_admin', 'payroll_staff', 'operator_admin'].includes(session.role);
  const confirmed = days.filter((d) => d.is_confirmed).length;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="flex gap-4 text-sm">
        <Link href="/employees" className="text-blue-600 underline">
          ← 직원 목록
        </Link>
        <Link href="/shifts" className="text-blue-600 underline">
          교대 · 스케줄
        </Link>
      </div>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">근태 마감</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {period} 차수 · 컷오프 {from} ~ {to} · 집계 {days.length}건 중 마감 {confirmed}건
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

      <AttendancePanel
        from={from}
        to={to}
        gate={gate}
        anomalies={anomalies.map((a) => ({
          ...a,
          employee_no: nameById.get(a.employee_id)?.no ?? '—',
          employee_name: nameById.get(a.employee_id)?.name ?? '(알 수 없음)',
        }))}
        canEdit={canEdit}
      />
    </main>
  );
}
