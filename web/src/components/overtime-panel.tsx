'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createOtRequestsAction,
  decideOtRequestAction,
  approveRetroactivelyAction,
  flagWeeklyCapAction,
} from '@/app/overtime/actions';
import { formatMinutes, type OtGap, type OtRequestRow, type WeeklyOverage } from '@/lib/attendance/overtime';

export interface EmployeeLite {
  id: string;
  employee_no: string;
  full_name: string;
}

interface Props {
  from: string;
  to: string;
  employees: EmployeeLite[];
  requests: OtRequestRow[];
  gaps: OtGap[];
  overages: WeeklyOverage[];
  canEdit: boolean;
  canApprove: boolean;
}

export function OvertimePanel({
  from,
  to,
  employees,
  requests,
  gaps,
  overages,
  canEdit,
  canApprove,
}: Props) {
  const nameById = new Map(employees.map((e) => [e.id, `${e.employee_no} ${e.full_name}`]));
  const pendingRequests = requests.filter((r) => r.status === 'pending');

  return (
    <div className="mt-8 space-y-12">
      <GapSection gaps={gaps} nameById={nameById} canApprove={canApprove} />
      <OverageSection overages={overages} nameById={nameById} canApprove={canApprove} />
      {canEdit && <RequestForm employees={employees} defaultDate={from} />}
      <RequestList
        requests={requests}
        pending={pendingRequests.length}
        nameById={nameById}
        canApprove={canApprove}
        from={from}
        to={to}
      />
    </div>
  );
}

function GapSection({
  gaps,
  nameById,
  canApprove,
}: {
  gaps: OtGap[];
  nameById: Map<string, string>;
  canApprove: boolean;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">사전승인 없는 초과근무</h2>
          <p className="mt-1 text-sm text-neutral-500">
            실제 근무한 OT와 승인 내역을 대사한 결과입니다. 남아 있으면 G1이 열리지 않습니다.
          </p>
        </div>
        <span className="text-sm text-neutral-500">{gaps.length}건</span>
      </div>

      {gaps.length === 0 ? (
        <p className="mt-3 rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
          모든 초과근무에 사전승인이 있습니다.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {gaps.map((g) => (
            <GapCard
              key={`${g.employee_id}|${g.work_date}`}
              gap={g}
              name={nameById.get(g.employee_id) ?? '(알 수 없음)'}
              canApprove={canApprove}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GapCard({
  gap,
  name,
  canApprove,
}: {
  gap: OtGap;
  name: string;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const r = await approveRetroactivelyAction({
      employeeId: gap.employee_id,
      workDate: gap.work_date,
      minutes: gap.worked_minutes,
      reason: String(fd.get('reason') ?? ''),
    });
    if (!r.ok) {
      setError(r.error ?? '처리에 실패했습니다.');
      setBusy(false);
      return;
    }
    setOpen(false);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-amber-300 p-4 dark:border-amber-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {name} <span className="ml-2 text-neutral-500">{gap.work_date}</span>
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            근무 {formatMinutes(gap.worked_minutes)} · 승인 {formatMinutes(gap.approved_minutes)} ·{' '}
            <span className="font-medium text-amber-700 dark:text-amber-300">
              미승인 {formatMinutes(gap.unapproved_minutes)}
            </span>
            {gap.retroactive && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                사후 승인됨
              </span>
            )}
          </p>
        </div>
        {canApprove && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            {open ? '취소' : '사후 승인'}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block flex-1">
            <span className="text-xs font-medium text-neutral-500">사후 승인 사유</span>
            <input
              name="reason"
              required
              placeholder="긴급 납기 대응 · 라인장 구두 지시 확인"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            disabled={busy}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            승인
          </button>
          {error && <p className="w-full text-sm text-red-600">{error}</p>}
        </form>
      )}
      {open && (
        <p className="mt-2 text-xs text-neutral-500">
          사후 승인은 사전승인이 아닙니다. 승인 시각이 근무일 이후로 기록되어 감사에서 구분되며,
          반복되면 사전 신청 절차 자체를 점검해야 한다는 신호입니다.
        </p>
      )}
    </div>
  );
}

function OverageSection({
  overages,
  nameById,
  canApprove,
}: {
  overages: WeeklyOverage[];
  nameById: Map<string, string>;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (overages.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold">주간 상한 초과</h2>
      <p className="mt-1 text-sm text-neutral-500">
        UU 13/2003은 주 18시간을 상한으로 둡니다. 초과 자체가 위법은 아니지만 특별승인이
        필요합니다.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-amber-300 dark:border-amber-900">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-amber-50 text-left dark:bg-amber-950">
            <tr>
              <th className="px-3 py-2 font-medium">직원</th>
              <th className="px-3 py-2 font-medium">주 시작</th>
              <th className="px-3 py-2 text-right font-medium">OT 합계</th>
              <th className="px-3 py-2 text-right font-medium">상한</th>
              {canApprove && <th className="w-32 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {overages.map((o) => (
              <tr
                key={`${o.employee_id}|${o.week_start}`}
                className="border-t border-amber-200 dark:border-amber-900"
              >
                <td className="px-3 py-2">{nameById.get(o.employee_id) ?? '—'}</td>
                <td className="px-3 py-2 tabular-nums">{o.week_start}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMinutes(o.minutes)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                  {formatMinutes(o.cap_minutes)}
                </td>
                {canApprove && (
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const end = new Date(`${o.week_start}T00:00:00Z`);
                          end.setUTCDate(end.getUTCDate() + 6);
                          await flagWeeklyCapAction(
                            o.employee_id,
                            o.week_start,
                            end.toISOString().slice(0, 10)
                          );
                          router.refresh();
                        })
                      }
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                    >
                      특별승인 표시
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestForm({
  employees,
  defaultDate,
}: {
  employees: EmployeeLite[];
  defaultDate: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const fd = new FormData(e.currentTarget);
    const r = await createOtRequestsAction({
      employeeIds: [...selected],
      workDate: String(fd.get('work_date') ?? ''),
      plannedMinutes: Number(fd.get('hours') ?? 0) * 60,
      reason: String(fd.get('reason') ?? ''),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '신청에 실패했습니다.');
    setMessage(`${r.created}건 신청했습니다.`);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-lg font-semibold">사전 신청</h2>
      <p className="mt-1 text-sm text-neutral-500">
        근무 전에 신청해야 사전승인으로 인정됩니다.
      </p>

      <form
        onSubmit={onSubmit}
        className="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">근무일</span>
            <input
              type="date"
              name="work_date"
              required
              defaultValue={defaultDate}
              className={input}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">예정 시간</span>
            <input
              type="number"
              name="hours"
              required
              min={0.5}
              step={0.5}
              defaultValue={2}
              className={`${input} w-24`}
            />
          </label>
          <label className="block flex-1">
            <span className="text-xs font-medium text-neutral-500">사유</span>
            <input name="reason" required placeholder="납기 대응" className={`${input} w-full`} />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {employees.map((e) => (
            <label
              key={e.id}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs ${
                selected.has(e.id)
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                  : 'border-neutral-300 dark:border-neutral-700'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={selected.has(e.id)}
                onChange={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(e.id)) next.delete(e.id);
                    else next.add(e.id);
                    return next;
                  })
                }
              />
              {e.employee_no} {e.full_name}
            </label>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            disabled={busy || selected.size === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            선택한 {selected.size}명 신청
          </button>
          {message && <span className="text-sm text-neutral-500">{message}</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>
    </section>
  );
}

function RequestList({
  requests,
  pending,
  nameById,
  canApprove,
}: {
  requests: OtRequestRow[];
  pending: number;
  nameById: Map<string, string>;
  canApprove: boolean;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const STATUS: Record<string, string> = {
    pending: '대기',
    approved: '승인',
    rejected: '반려',
    cancelled: '취소',
  };

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">신청 내역</h2>
        <span className="text-sm text-neutral-500">
          대기 {pending}건 · 전체 {requests.length}건
        </span>
      </div>

      {requests.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">이 기간에 신청이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">근무일</th>
                <th className="px-3 py-2 font-medium">직원</th>
                <th className="px-3 py-2 text-right font-medium">예정</th>
                <th className="px-3 py-2 text-right font-medium">실제</th>
                <th className="px-3 py-2 font-medium">사유</th>
                <th className="px-3 py-2 font-medium">상태</th>
                {canApprove && <th className="w-32 px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2 tabular-nums">{r.work_date}</td>
                  <td className="px-3 py-2">{nameById.get(r.employee_id) ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinutes(r.planned_minutes)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.actual_minutes === null ? '—' : formatMinutes(r.actual_minutes)}
                  </td>
                  <td className="px-3 py-2">
                    {r.reason ?? '—'}
                    {r.over_weekly_cap && (
                      <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                        주간상한 특별승인
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {STATUS[r.status] ?? r.status}
                    {r.status === 'approved' &&
                      r.approved_at &&
                      r.approved_at.slice(0, 10) > r.work_date && (
                        <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                          (사후)
                        </span>
                      )}
                  </td>
                  {canApprove && (
                    <td className="px-3 py-2 text-right">
                      {r.status === 'pending' && (
                        <span className="flex justify-end gap-2">
                          <button
                            disabled={busy}
                            onClick={() =>
                              startTransition(async () => {
                                await decideOtRequestAction(r.id, 'approved');
                                router.refresh();
                              })
                            }
                            className="text-xs text-blue-600 underline disabled:opacity-50"
                          >
                            승인
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              startTransition(async () => {
                                await decideOtRequestAction(r.id, 'rejected');
                                router.refresh();
                              })
                            }
                            className="text-xs text-neutral-500 underline disabled:opacity-50"
                          >
                            반려
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
