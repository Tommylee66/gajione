/**
 * Turns raw punches into the confirmed day rows payroll is computed from.
 *
 * The two are separate tables on purpose. A punch is what a terminal reported
 * and is never edited; a day is an interpretation, and interpretations get
 * corrected. Keeping the raw record intact is what lets the company answer
 * "why did you decide he finished at 04:10 when there is no punch" months
 * later — the mockup's own example is a missing night-shift check-out fixed
 * from terminal logs and CCTV.
 */

export interface RawPunch {
  employee_id: string;
  punched_at: string;
  direction: 'in' | 'out';
}

export interface ShiftDef {
  id: string;
  start_time: string; // 'HH:MM:SS'
  end_time: string;
  break_minutes: number;
  crosses_midnight: boolean;
}

export interface ScheduleEntry {
  employee_id: string;
  work_date: string; // 'YYYY-MM-DD'
  shift_id: string | null;
}

export interface LeaveDay {
  employee_id: string;
  work_date: string;
}

export type AnomalyType =
  | 'missing_check_out'
  | 'missing_check_in'
  | 'late'
  | 'early_leave'
  | 'leave_overlap'
  | 'no_schedule';

export interface BuiltDay {
  employee_id: string;
  work_date: string;
  shift_id: string | null;
  check_in: string | null;
  check_out: string | null;
  work_minutes: number;
  late_minutes: number;
  early_leave_minutes: number;
  ot_minutes: number;
  status: 'present' | 'absent' | 'leave' | 'anomaly';
}

export interface BuiltAnomaly {
  employee_id: string;
  work_date: string;
  anomaly_type: AnomalyType;
  detail: string;
}

export interface BuildResult {
  days: BuiltDay[];
  anomalies: BuiltAnomaly[];
}

/** Grace before a late arrival is worth raising. Below this it is noise. */
const LATE_GRACE_MINUTES = 5;

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function shiftBoundaries(workDate: string, shift: ShiftDef, tzOffset: string) {
  const start = new Date(`${workDate}T${shift.start_time}${tzOffset}`);
  const end = new Date(`${workDate}T${shift.end_time}${tzOffset}`);
  // A night shift ends the following calendar day; without this the scheduled
  // length comes out negative and every night worker looks absent.
  if (shift.crosses_midnight || end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

/**
 * Punches are assigned to the day their shift starts on, not the calendar day
 * they happened. A 04:10 check-out belongs to the previous night's shift.
 */
export function buildDays(
  punches: RawPunch[],
  schedules: ScheduleEntry[],
  shifts: Map<string, ShiftDef>,
  leaves: LeaveDay[],
  tzOffset = '+07:00'
): BuildResult {
  const days: BuiltDay[] = [];
  const anomalies: BuiltAnomaly[] = [];

  const leaveSet = new Set(leaves.map((l) => `${l.employee_id}|${l.work_date}`));
  const byKey = new Map<string, RawPunch[]>();

  for (const schedule of schedules) {
    byKey.set(`${schedule.employee_id}|${schedule.work_date}`, []);
  }

  for (const punch of punches) {
    const at = new Date(punch.punched_at);
    // Find the scheduled window this punch falls in, allowing a few hours
    // either side for early arrivals and overtime.
    let assigned: string | null = null;
    for (const schedule of schedules) {
      if (schedule.employee_id !== punch.employee_id) continue;
      const shift = schedule.shift_id ? shifts.get(schedule.shift_id) : undefined;
      if (!shift) continue;
      const { start, end } = shiftBoundaries(schedule.work_date, shift, tzOffset);
      const from = new Date(start.getTime() - 4 * 3600_000);
      const to = new Date(end.getTime() + 6 * 3600_000);
      if (at >= from && at <= to) {
        assigned = `${schedule.employee_id}|${schedule.work_date}`;
        break;
      }
    }

    if (!assigned) {
      // A punch with no roster entry. Recorded as an anomaly rather than
      // dropped — somebody worked, and the schedule is what is wrong.
      const workDate = punch.punched_at.slice(0, 10);
      anomalies.push({
        employee_id: punch.employee_id,
        work_date: workDate,
        anomaly_type: 'no_schedule',
        detail: `근무 스케줄이 없는 시각에 기록됨 (${punch.punched_at})`,
      });
      continue;
    }
    byKey.get(assigned)!.push(punch);
  }

  for (const schedule of schedules) {
    const key = `${schedule.employee_id}|${schedule.work_date}`;
    const list = (byKey.get(key) ?? []).sort(
      (a, b) => new Date(a.punched_at).getTime() - new Date(b.punched_at).getTime()
    );
    const shift = schedule.shift_id ? shifts.get(schedule.shift_id) : undefined;
    const onLeave = leaveSet.has(key);

    const ins = list.filter((p) => p.direction === 'in');
    const outs = list.filter((p) => p.direction === 'out');
    const checkIn = ins[0]?.punched_at ?? null;
    // Last out, not first: a mid-shift exit for lunch should not close the day.
    const checkOut = outs.length > 0 ? outs[outs.length - 1].punched_at : null;

    let status: BuiltDay['status'] = 'present';
    let workMinutes = 0;
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let otMinutes = 0;

    if (onLeave && (checkIn || checkOut)) {
      // Both a leave request and attendance for the same day. The mockup
      // resolves this case by confirming attendance and restoring the leave,
      // but which is right is a judgement, so it is raised rather than decided.
      anomalies.push({
        employee_id: schedule.employee_id,
        work_date: schedule.work_date,
        anomaly_type: 'leave_overlap',
        detail: '연차 신청과 출근 기록이 함께 있습니다.',
      });
      status = 'anomaly';
    } else if (onLeave) {
      status = 'leave';
    } else if (!checkIn && !checkOut) {
      status = 'absent';
    } else if (!checkOut) {
      anomalies.push({
        employee_id: schedule.employee_id,
        work_date: schedule.work_date,
        anomaly_type: 'missing_check_out',
        detail: `출근 ${checkIn} 기록은 있으나 퇴근 기록이 없습니다.`,
      });
      status = 'anomaly';
    } else if (!checkIn) {
      anomalies.push({
        employee_id: schedule.employee_id,
        work_date: schedule.work_date,
        anomaly_type: 'missing_check_in',
        detail: `퇴근 ${checkOut} 기록은 있으나 출근 기록이 없습니다.`,
      });
      status = 'anomaly';
    }

    if (shift) {
      const { start, end } = shiftBoundaries(schedule.work_date, shift, tzOffset);

      // Lateness needs only the arrival. Tying it to a complete pair would
      // lose it on exactly the days that already went wrong — somebody who
      // arrived 42 minutes late and whose check-out failed is both late and
      // missing a punch, and the payroll clerk has to see both.
      if (checkIn) {
        lateMinutes = Math.max(0, minutesBetween(start, new Date(checkIn)));
        if (lateMinutes > LATE_GRACE_MINUTES) {
          anomalies.push({
            employee_id: schedule.employee_id,
            work_date: schedule.work_date,
            anomaly_type: 'late',
            detail: `지각 ${lateMinutes}분`,
          });
          status = status === 'present' ? 'anomaly' : status;
        }
      }

      if (checkIn && checkOut) {
        const inAt = new Date(checkIn);
        const outAt = new Date(checkOut);

        workMinutes = Math.max(0, minutesBetween(inAt, outAt) - shift.break_minutes);
        const scheduled = Math.max(0, minutesBetween(start, end) - shift.break_minutes);

        earlyLeaveMinutes = Math.max(0, minutesBetween(outAt, end));
        // Overtime is measured against the roster, not the clock: staying late
        // to make up a late start is not overtime.
        otMinutes = Math.max(0, workMinutes - scheduled);
      }
    }

    days.push({
      employee_id: schedule.employee_id,
      work_date: schedule.work_date,
      shift_id: schedule.shift_id,
      check_in: checkIn,
      check_out: checkOut,
      work_minutes: workMinutes,
      late_minutes: lateMinutes,
      early_leave_minutes: earlyLeaveMinutes,
      ot_minutes: otMinutes,
      status,
    });
  }

  return { days, anomalies };
}

/**
 * G1 passes when the period is clean. Each check maps to a gate_rules row, and
 * the reasons come back so the screen can say what is blocking rather than
 * just refusing.
 */
export interface GateInput {
  devicesTotal: number;
  devicesSynced: number;
  openAnomalies: number;
  otMinutesWithoutApproval: number;
  employeesOverWeeklyCap: number;
}

export interface GateCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
  blocking: boolean;
}

export function evaluateG1(input: GateInput): GateCheck[] {
  return [
    {
      code: 'G1_DEVICE_SYNC',
      label: '지문기 동기화',
      passed: input.devicesTotal === 0 || input.devicesSynced === input.devicesTotal,
      detail: `${input.devicesSynced}/${input.devicesTotal}`,
      blocking: true,
    },
    {
      code: 'G1_ANOMALY_CLEAR',
      label: '이상근태 전건 해결',
      passed: input.openAnomalies === 0,
      detail: input.openAnomalies === 0 ? '없음' : `미해결 ${input.openAnomalies}건`,
      blocking: true,
    },
    {
      code: 'G1_OT_PREAPPROVED',
      label: 'OT 사전승인',
      passed: input.otMinutesWithoutApproval === 0,
      detail:
        input.otMinutesWithoutApproval === 0
          ? '100%'
          : `미승인 ${Math.round(input.otMinutesWithoutApproval / 60)}시간`,
      blocking: true,
    },
    {
      code: 'G1_WEEKLY_OT_CAP',
      label: '주간 OT 상한 (18시간)',
      passed: input.employeesOverWeeklyCap === 0,
      detail:
        input.employeesOverWeeklyCap === 0
          ? '초과 없음'
          : `${input.employeesOverWeeklyCap}명 초과 — 특별승인 필요`,
      blocking: false,
    },
  ];
}
