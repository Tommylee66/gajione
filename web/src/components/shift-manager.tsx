'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createShiftAction,
  setShiftActiveAction,
  assignScheduleAction,
  clearScheduleAction,
  type ActionResult,
} from '@/app/shifts/actions';
import { eachDate, summarisePattern, type PatternSlot } from '@/lib/attendance/rotation';

export interface ShiftRow {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  crosses_midnight: boolean;
  is_night: boolean;
  active: boolean;
}

export interface EmployeeRow {
  id: string;
  employee_no: string;
  full_name: string;
  department_id: string | null;
  department_name: string | null;
}

export interface ScheduleCell {
  employee_id: string;
  work_date: string;
  shift_id: string | null;
}

interface Props {
  shifts: ShiftRow[];
  employees: EmployeeRow[];
  schedules: ScheduleCell[];
  from: string;
  to: string;
  canEdit: boolean;
}

export function ShiftManager({ shifts, employees, schedules, from, to, canEdit }: Props) {
  return (
    <div className="mt-8 space-y-12">
      <ShiftSection shifts={shifts} canEdit={canEdit} />
      <ScheduleSection
        shifts={shifts.filter((s) => s.active)}
        employees={employees}
        schedules={schedules}
        from={from}
        to={to}
        canEdit={canEdit}
      />
    </div>
  );
}

function ShiftSection({ shifts, canEdit }: { shifts: ShiftRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    const r = await createShiftAction({
      name: String(fd.get('name') ?? ''),
      start_time: String(fd.get('start_time') ?? ''),
      end_time: String(fd.get('end_time') ?? ''),
      break_minutes: Number(fd.get('break_minutes') ?? 0),
      is_night: fd.get('is_night') === 'on',
    });
    if (!r.ok) return setError(r.error ?? '등록에 실패했습니다.');
    form.reset();
    setOpen(false);
    router.refresh();
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">교대 정의</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {shifts.filter((s) => s.active).length}개 사용 중
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
          >
            {open ? '취소' : '교대 추가'}
          </button>
        )}
      </div>

      {open && (
        <form
          onSubmit={onCreate}
          className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <Labeled label="교대명">
            <input name="name" required placeholder="주간" className={`${input} w-32`} />
          </Labeled>
          <Labeled label="시작">
            <input name="start_time" type="time" required defaultValue="08:00" className={input} />
          </Labeled>
          <Labeled label="종료">
            <input name="end_time" type="time" required defaultValue="17:00" className={input} />
          </Labeled>
          <Labeled label="휴게(분)">
            <input
              name="break_minutes"
              type="number"
              min={0}
              defaultValue={60}
              className={`${input} w-24`}
            />
          </Labeled>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input name="is_night" type="checkbox" />
            야간
          </label>
          <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            추가
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">교대명</th>
              <th className="px-3 py-2 font-medium">시간</th>
              <th className="px-3 py-2 text-right font-medium">휴게</th>
              <th className="px-3 py-2 font-medium">자정 넘김</th>
              <th className="px-3 py-2 font-medium">상태</th>
              {canEdit && <th className="w-28 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">
                  {s.name}
                  {s.is_night && (
                    <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                      야간
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{s.break_minutes}분</td>
                <td className="px-3 py-2">{s.crosses_midnight ? '예' : '—'}</td>
                <td className="px-3 py-2">
                  {s.active ? (
                    <span className="text-neutral-600 dark:text-neutral-400">사용</span>
                  ) : (
                    <span className="text-neutral-400">미사용</span>
                  )}
                </td>
                {canEdit && (
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await setShiftActiveAction(s.id, !s.active);
                          router.refresh();
                        })
                      }
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                    >
                      {s.active ? '미사용으로' : '다시 사용'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        자정 넘김은 시작·종료 시각에서 자동으로 정해집니다. 종료가 시작보다 빠르면 다음 날로
        넘어가는 교대입니다 — 따로 묻지 않는 이유는 둘이 어긋나면 야간 근무자 전원의 근무시간이
        음수가 되기 때문입니다.
      </p>
    </section>
  );
}

function ScheduleSection({
  shifts,
  employees,
  schedules,
  from,
  to,
  canEdit,
}: {
  shifts: ShiftRow[];
  employees: EmployeeRow[];
  schedules: ScheduleCell[];
  from: string;
  to: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pattern, setPattern] = useState<PatternSlot[]>([]);
  const [offset, setOffset] = useState(0);
  const [group, setGroup] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const dates = useMemo(() => eachDate(from, to), [from, to]);
  const shiftNames = useMemo(() => new Map(shifts.map((s) => [s.id, s.name])), [shifts]);
  const cellByKey = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of schedules) m.set(`${s.employee_id}|${s.work_date}`, s.shift_id);
    return m;
  }, [schedules]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">근무 스케줄</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {from} ~ {to} · {dates.length}일 · 직원 {employees.length}명
          </p>
        </div>
      </div>

      {canEdit && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">패턴 배정</h3>
          <p className="mt-1 text-xs text-neutral-500">
            3조2교대는 같은 패턴을 조마다 시작 위치만 바꿔 적용합니다. 예를 들어 주주야야휴휴
            패턴에 A조 0, B조 2, C조 4를 주면 세 조가 서로 다른 날 야간에 들어갑니다.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-neutral-500">패턴</span>
            {pattern.map((slot, i) => (
              <span
                key={i}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
              >
                {slot ? (shiftNames.get(slot) ?? '?') : '휴무'}
              </span>
            ))}
            {pattern.length === 0 && <span className="text-xs text-neutral-400">비어 있음</span>}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {shifts.map((s) => (
              <button
                key={s.id}
                onClick={() => setPattern((p) => [...p, s.id])}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
              >
                + {s.name}
              </button>
            ))}
            <button
              onClick={() => setPattern((p) => [...p, null])}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
            >
              + 휴무
            </button>
            <button
              onClick={() => setPattern([])}
              className="rounded-md px-3 py-1 text-xs text-neutral-500 underline"
            >
              비우기
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Labeled label="시작 위치">
              <input
                type="number"
                min={0}
                value={offset}
                onChange={(e) => setOffset(Number(e.target.value))}
                className={`${input} w-20`}
              />
            </Labeled>
            <Labeled label="조 이름">
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="A조"
                className={`${input} w-24`}
              />
            </Labeled>
            <button
              disabled={pending || selected.size === 0 || pattern.length === 0}
              onClick={() =>
                startTransition(async () => {
                  setResult(
                    await assignScheduleAction({
                      employeeIds: [...selected],
                      from,
                      to,
                      pattern,
                      offset,
                      rotationGroup: group || null,
                    })
                  );
                  router.refresh();
                })
              }
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              선택한 {selected.size}명에 배정
            </button>
            <button
              disabled={pending || selected.size === 0}
              onClick={() =>
                startTransition(async () => {
                  setResult(await clearScheduleAction([...selected], from, to));
                  router.refresh();
                })
              }
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
            >
              기간 비우기
            </button>
          </div>

          {pattern.length > 0 && (
            <p className="mt-2 text-xs text-neutral-500">
              반복: {summarisePattern(pattern, shiftNames)} ({pattern.length}일 주기)
            </p>
          )}

          {result && (
            <p className={`mt-2 text-sm ${result.ok ? 'text-neutral-600 dark:text-neutral-400' : 'text-red-600'}`}>
              {result.ok
                ? `${result.assigned}일 배정 완료${
                    result.skippedConfirmed ? ` · 마감된 ${result.skippedConfirmed}일은 건너뜀` : ''
                  }`
                : result.error}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 dark:bg-neutral-900">
            <tr>
              {canEdit && <th className="w-8 px-2 py-2" />}
              <th className="sticky left-0 bg-neutral-50 px-3 py-2 text-left font-medium dark:bg-neutral-900">
                직원
              </th>
              {dates.map((d) => (
                <th key={d} className="px-1 py-2 text-center font-medium tabular-nums">
                  {d.slice(8)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-t border-neutral-200 dark:border-neutral-800">
                {canEdit && (
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selected.has(e.id)}
                      onChange={() => toggle(e.id)}
                    />
                  </td>
                )}
                <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1 dark:bg-neutral-950">
                  {e.employee_no} {e.full_name}
                  {e.department_name && (
                    <span className="ml-1 text-neutral-400">{e.department_name}</span>
                  )}
                </td>
                {dates.map((d) => {
                  const key = `${e.id}|${d}`;
                  const has = cellByKey.has(key);
                  const shiftId = cellByKey.get(key) ?? null;
                  return (
                    <td
                      key={d}
                      title={has ? (shiftId ? shiftNames.get(shiftId) : '휴무') : '미배정'}
                      className={`px-1 py-1 text-center ${
                        !has
                          ? 'text-neutral-300 dark:text-neutral-700'
                          : shiftId
                            ? 'text-neutral-800 dark:text-neutral-200'
                            : 'text-neutral-400'
                      }`}
                    >
                      {!has ? '·' : shiftId ? (shiftNames.get(shiftId) ?? '?').slice(0, 1) : '휴'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        점(·)은 미배정입니다. 휴무는 행이 있는 상태로 저장되므로 &ldquo;쉬는 날&rdquo;과
        &ldquo;아무도 배정하지 않은 날&rdquo;이 구분됩니다 — 앞은 정상이고 뒤는 G1이 잡아야 할
        누락입니다.
      </p>
    </section>
  );
}

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
