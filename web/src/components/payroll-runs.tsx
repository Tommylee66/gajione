'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createRunAction, computeRunAction, type RunResult } from '@/app/payroll/actions';
import { formatRupiah } from '@/lib/format';

export interface RunRow {
  id: string;
  period: string;
  run_type: string;
  status: string;
  cutoff_start: string;
  cutoff_end: string;
  pay_date: string;
  employee_count: number;
  gross_total: number;
  deduction_total: number;
  net_total: number;
  batch_hash: string | null;
  tax_table_version: string | null;
}

const STATUS: Record<string, string> = {
  draft: '작성 중',
  g1_passed: 'G1 통과',
  g2_passed: 'G2 통과',
  g3_passed: 'G3 통과',
  approved: '승인됨',
  locked: '마감',
  cancelled: '취소',
};

export function PayrollRuns({ runs, canRun }: { runs: RunRow[]; canRun: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RunResult | null>(null);

  return (
    <div className="mt-8 space-y-6">
      {canRun && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const period = String(new FormData(e.currentTarget).get('period') ?? '');
            startTransition(async () => {
              setResult(await createRunAction(period));
              router.refresh();
            });
          }}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">차수</span>
            <input
              type="month"
              name="period"
              required
              defaultValue="2026-08"
              className="mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            disabled={pending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            차수 생성
          </button>
          {result && !result.ok && <span className="text-sm text-red-600">{result.error}</span>}
        </form>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">차수</th>
              <th className="px-3 py-2 font-medium">컷오프</th>
              <th className="px-3 py-2 font-medium">상태</th>
              <th className="px-3 py-2 text-right font-medium">인원</th>
              <th className="px-3 py-2 text-right font-medium">지급총액</th>
              <th className="px-3 py-2 text-right font-medium">공제</th>
              <th className="px-3 py-2 text-right font-medium">실지급</th>
              {canRun && <th className="w-24 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={canRun ? 8 : 7} className="px-3 py-10 text-center text-neutral-500">
                  아직 차수가 없습니다.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">
                  <Link href={`/payroll/${r.id}`} className="text-blue-600 underline">
                    {r.period}
                  </Link>
                  {r.batch_hash && (
                    <span className="ml-2 font-mono text-xs text-neutral-400">
                      {r.batch_hash.slice(0, 8)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-neutral-500">
                  {r.cutoff_start} ~ {r.cutoff_end}
                </td>
                <td className="px-3 py-2">{STATUS[r.status] ?? r.status}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.employee_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(r.gross_total)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatRupiah(r.deduction_total)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {formatRupiah(r.net_total)}
                </td>
                {canRun && (
                  <td className="px-3 py-2 text-right">
                    {r.status !== 'locked' && (
                      <button
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            setResult(await computeRunAction(r.id));
                            router.refresh();
                          })
                        }
                        className="text-xs text-blue-600 underline disabled:opacity-50"
                      >
                        {r.batch_hash ? '재계산' : '계산'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result?.ok && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {result.employees}명 계산 완료 · 두 번 계산 결과 일치
          {result.warnings ? ` · 경고 ${result.warnings}건` : ''}
        </p>
      )}
      {result && !result.ok && result.hashMatch === false && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {result.error}
        </p>
      )}
    </div>
  );
}
