import { createClient } from '@/lib/supabase/server';
import { requireMe } from '@/lib/me/data';
import { LeaveRequest, type LeaveTypeOption } from '@/components/me-leave';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  present: '정상',
  absent: '결근',
  leave: '연차',
  holiday: '휴일',
  anomaly: '확인 필요',
};

const LEAVE_STATUS: Record<string, string> = {
  pending: '검토중',
  approved: '승인',
  rejected: '반려',
  cancelled: '취소',
};

export default async function MeAttendance() {
  await requireMe();
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));

  const [dayRes, schedRes, shiftRes, leaveRes, balanceRes, typeRes] = await Promise.all([
    supabase
      .from('attendance_days')
      .select('work_date, check_in, check_out, late_minutes, ot_minutes, status, is_confirmed')
      .order('work_date', { ascending: false })
      .limit(14),
    supabase
      .from('shift_schedules')
      .select('work_date, shift_id')
      .gte('work_date', today)
      .order('work_date')
      .limit(7),
    supabase.from('shifts').select('id, name, start_time, end_time'),
    supabase
      .from('leaves')
      .select('start_date, end_date, days, status, leave_type_id')
      .order('start_date', { ascending: false })
      .limit(6),
    supabase.from('leave_balances').select('leave_type_id, entitled, used, carried_over').eq('year', year),
    supabase.from('leave_types').select('id, name'),
  ]);

  const shifts = new Map(
    (shiftRes.data ?? []).map((s) => [
      s.id as string,
      `${s.name} ${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`,
    ])
  );
  const typeNames = new Map((typeRes.data ?? []).map((t) => [t.id as string, t.name as string]));

  const days = dayRes.data ?? [];
  const todayRow = days.find((d) => d.work_date === today);
  const weekStart = new Date(Date.parse(`${today}T00:00:00Z`));
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const weekFrom = weekStart.toISOString().slice(0, 10);
  const thisWeek = days.filter((d) => (d.work_date as string) >= weekFrom);
  const weekOt = thisWeek.reduce((s, d) => s + Number(d.ot_minutes ?? 0), 0);

  const pendingByType = new Map<string, number>();
  for (const l of leaveRes.data ?? []) {
    if (l.status !== 'pending') continue;
    const k = l.leave_type_id as string;
    pendingByType.set(k, (pendingByType.get(k) ?? 0) + Number(l.days));
  }
  const options: LeaveTypeOption[] = (balanceRes.data ?? []).map((b) => {
    const held = pendingByType.get(b.leave_type_id as string) ?? 0;
    return {
      id: b.leave_type_id as string,
      name: typeNames.get(b.leave_type_id as string) ?? '연차',
      entitled: Number(b.entitled) + Number(b.carried_over),
      used: Number(b.used),
      pending: held,
      remaining: Number(b.entitled) + Number(b.carried_over) - Number(b.used) - held,
    };
  });

  return (
    <>
      <h1 className="text-xl font-semibold">근태·연차</h1>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">오늘 ({today})</p>
        {todayRow ? (
          <>
            <p className="mt-1 text-sm font-medium">
              {STATUS_LABELS[todayRow.status as string] ?? todayRow.status}
              {!todayRow.is_confirmed && (
                <span className="ml-2 text-xs font-normal text-neutral-500">미확정</span>
              )}
            </p>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              출근 {todayRow.check_in ? String(todayRow.check_in).slice(11, 16) : '—'} · 퇴근{' '}
              {todayRow.check_out ? String(todayRow.check_out).slice(11, 16) : '—'}
              {Number(todayRow.late_minutes) > 0 && ` · 지각 ${todayRow.late_minutes}분`}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-neutral-500">오늘 기록이 아직 없습니다.</p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          이번 주 {thisWeek.length}일 기록
          {weekOt > 0 && ` · OT ${Math.floor(weekOt / 60)}시간 ${weekOt % 60}분`}
        </p>
      </section>

      {(schedRes.data ?? []).length > 0 && (
        <section className="mt-4">
          <h2 className="text-sm font-semibold">다가오는 교대</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(schedRes.data ?? []).map((s, i) => (
              <li key={i} className="flex justify-between">
                <span>{s.work_date as string}</span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {s.shift_id ? (shifts.get(s.shift_id as string) ?? '—') : '휴무'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <LeaveRequest options={options} />

      {(leaveRes.data ?? []).length > 0 && (
        <section className="mt-4">
          <h2 className="text-sm font-semibold">최근 신청</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(leaveRes.data ?? []).map((l, i) => (
              <li key={i} className="flex justify-between">
                <span>
                  {l.start_date as string}
                  {l.start_date !== l.end_date && ` ~ ${l.end_date}`} · {l.days}일
                </span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {LEAVE_STATUS[l.status as string] ?? l.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">최근 근태</h2>
        {days.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">기록이 없습니다.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {days.map((d, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs text-neutral-500">{d.work_date as string}</span>
                <span className="flex-1 text-neutral-600 dark:text-neutral-400">
                  {d.check_in ? String(d.check_in).slice(11, 16) : '—'} –{' '}
                  {d.check_out ? String(d.check_out).slice(11, 16) : '—'}
                </span>
                <span className={Number(d.late_minutes) > 0 ? 'text-amber-600' : 'text-neutral-500'}>
                  {STATUS_LABELS[d.status as string] ?? d.status}
                  {Number(d.late_minutes) > 0 && ` +${d.late_minutes}분`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
