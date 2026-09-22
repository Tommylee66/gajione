'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestLeaveAction } from '@/app/me/actions';

export interface LeaveTypeOption {
  id: string;
  name: string;
  entitled: number;
  used: number;
  pending: number;
  remaining: number;
}

export function LeaveRequest({ options }: { options: LeaveTypeOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState(options[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await requestLeaveAction({ leaveTypeId: typeId, startDate: from, endDate: to, days, reason });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '신청에 실패했습니다.');
    setNote('신청했습니다. 라인장 검토 후 반영됩니다.');
    setOpen(false);
    router.refresh();
  }

  if (options.length === 0) {
    return (
      <section className="mt-4">
        <h2 className="text-sm font-semibold">연차</h2>
        <p className="mt-2 text-sm text-neutral-500">올해 연차 부여 내역이 없습니다.</p>
      </section>
    );
  }

  return (
    <section className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">연차</h2>
        <button onClick={() => setOpen((v) => !v)} className="text-sm text-blue-600 underline">
          {open ? '닫기' : '연차 신청'}
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {options.map((o) => (
          <li key={o.id} className="flex justify-between">
            <span>{o.name}</span>
            <span className="tabular-nums">
              {o.remaining} / {o.entitled}일
              {/* Pending days are already spoken for. Showing only "remaining"
                  would let somebody request the same days twice. */}
              {o.pending > 0 && (
                <span className="ml-1 text-xs text-neutral-500">(검토중 {o.pending}일)</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {open && (
        <div className="mt-3 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <label className="block text-sm">
            <span className="text-xs text-neutral-500">종류</span>
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} (잔여 {o.remaining}일)
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="text-xs text-neutral-500">시작</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-neutral-500">종료</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-xs text-neutral-500">일수 (반차는 0.5)</span>
            <input
              type="number"
              step={0.5}
              min={0.5}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-neutral-500">사유 (선택)</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            disabled={busy || !from || !to}
            onClick={submit}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            신청
          </button>
        </div>
      )}

      {note && <p className="mt-2 text-sm text-neutral-500">{note}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
