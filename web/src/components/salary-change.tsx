'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { changeSalaryAction } from '@/app/employees/actions';
import { formatRupiah } from '@/lib/format';

/**
 * Pay changes are their own action, not a field on the edit form. Two reasons:
 * the history row is what G3's ±20% variance check reads, and a raise is a
 * decision somebody has to be able to point at afterwards — so the reason is
 * required rather than optional.
 */
export function SalaryChange({
  employeeId,
  currentSalary,
}: {
  employeeId: string;
  currentSalary: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(currentSalary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeRate = currentSalary > 0 ? ((amount - currentSalary) / currentSalary) * 100 : 0;
  // Not a block — a 25% raise is legitimate. It flags that this one will
  // surface in G3 and need an explanation, so nobody is surprised at closing.
  const willTripVariance = Math.abs(changeRate) > 20;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const result = await changeSalaryAction(employeeId, {
      new_amount: Number(fd.get('new_amount') ?? 0),
      effective_date: String(fd.get('effective_date') ?? ''),
      reason: String(fd.get('reason') ?? ''),
    });
    if (!result.ok) {
      setError(result.error ?? '급여 변경에 실패했습니다.');
      setBusy(false);
      return;
    }
    setOpen(false);
    setBusy(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
      >
        급여 변경
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">변경 후 기본급 (Rp)</span>
          <input
            type="number"
            name="new_amount"
            required
            min={0}
            step={1000}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">효력일</span>
          <input
            type="date"
            name="effective_date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">사유</span>
          <input
            name="reason"
            required
            placeholder="정기 인상 / 승진 / 직무 변경"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
      </div>

      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        {formatRupiah(currentSalary)} → {formatRupiah(amount)}{' '}
        <span className={changeRate >= 0 ? 'text-blue-600' : 'text-red-600'}>
          ({changeRate >= 0 ? '+' : ''}
          {changeRate.toFixed(1)}%)
        </span>
      </p>

      {willTripVariance && (
        <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          변동률이 ±20%를 넘습니다. 다음 차수의 품질게이트 G3에서 소명 대상으로 잡히며,
          라인장 1차 소명과 HR 2차 승인을 거쳐야 지급이 진행됩니다.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy || amount === currentSalary}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? '저장 중…' : '변경'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
        >
          취소
        </button>
      </div>
    </form>
  );
}
