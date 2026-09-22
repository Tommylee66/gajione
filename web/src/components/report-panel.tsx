'use client';

import { useState } from 'react';
import { generateReportAction, type ReportParams } from '@/app/reports/actions';
import {
  CATEGORIES,
  reportsFor,
  type CategoryId,
  type ReportDef,
} from '@/lib/reports/catalogue';

const primary =
  'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';
const field =
  'rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export interface RunOption {
  id: string;
  label: string;
}

function download(filename: string, text: string) {
  // BOM, because these files are opened in Excel on Indonesian and Korean
  // Windows and a UTF-8 CSV without one renders the names as mojibake.
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportPanel({ runs, years }: { runs: RunOption[]; years: number[] }) {
  const [category, setCategory] = useState<CategoryId>('payslip');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    def: ReportDef;
    rows: Record<string, string | number | null>[];
    columns: string[];
    total: number;
  } | null>(null);

  const cat = CATEGORIES.find((c) => c.id === category)!;

  async function run(def: ReportDef, params: ReportParams, mode: 'download' | 'view') {
    setBusy(def.id);
    setError(null);
    const r = await generateReportAction(def.id, params);
    setBusy(null);
    if (!r.ok) {
      setResult(null);
      return setError(r.error ?? '생성에 실패했습니다.');
    }
    if (r.rowCount === 0) {
      setResult({ def, rows: [], columns: r.columns ?? def.columns, total: 0 });
      // Said out loud rather than handing over an empty file: zero rows and a
      // wrong date range look identical once the download is open.
      return setError('조건에 해당하는 데이터가 없습니다.');
    }
    if (mode === 'download') download(r.filename!, r.csv!);
    setResult({ def, rows: r.preview ?? [], columns: r.columns ?? def.columns, total: r.rowCount! });
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      <nav className="space-y-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setCategory(c.id);
              setResult(null);
              setError(null);
            }}
            className={`block w-full rounded-lg border px-3 py-2 text-left ${
              c.id === category
                ? 'border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950'
                : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-900'
            }`}
          >
            <span className="block text-sm font-medium">{c.name}</span>
            <span className="block text-xs text-neutral-500">{c.description}</span>
          </button>
        ))}
      </nav>

      <div>
        <h2 className="text-lg font-semibold">{cat.name}</h2>
        {cat.unavailable ? (
          /* The category is listed because the mockup lists it, and marked
             unavailable because nothing in the system produces this data. */
          <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
            {cat.unavailable}
          </p>
        ) : (
          <div className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {reportsFor(category).map((def) => (
              <ReportRow
                key={def.id}
                def={def}
                runs={runs}
                years={years}
                busy={busy === def.id}
                onRun={run}
              />
            ))}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        {result && result.rows.length > 0 && (
          <section className="mt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-base font-semibold">{result.def.name}</h3>
              <p className="text-sm text-neutral-500">
                총 {result.total.toLocaleString('ko-KR')}행
                {result.total > result.rows.length && ` · 상위 ${result.rows.length}행 표시`}
              </p>
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-sm" style={{ minWidth: result.columns.length * 110 }}>
                <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
                      {result.columns.map((c) => (
                        <td
                          key={c}
                          className={`whitespace-nowrap px-3 py-2 ${
                            typeof row[c] === 'number' ? 'text-right tabular-nums' : ''
                          }`}
                        >
                          {row[c] === null || row[c] === undefined || row[c] === '' ? (
                            <span className="text-neutral-400">—</span>
                          ) : typeof row[c] === 'number' ? (
                            (row[c] as number).toLocaleString('id-ID')
                          ) : (
                            String(row[c])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ReportRow({
  def,
  runs,
  years,
  busy,
  onRun,
}: {
  def: ReportDef;
  runs: RunOption[];
  years: number[];
  busy: boolean;
  onRun: (def: ReportDef, params: ReportParams, mode: 'download' | 'view') => void;
}) {
  const now = new Date();
  const [runId, setRunId] = useState(runs[0]?.id ?? '');
  const [year, setYear] = useState(years[0] ?? now.getFullYear());
  const [from, setFrom] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  );
  const [to, setTo] = useState(now.toISOString().slice(0, 10));

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{def.name}</p>
        <p className="mt-0.5 text-sm text-neutral-500">{def.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {def.scope === 'period' && (
          <select value={runId} onChange={(e) => setRunId(e.target.value)} className={field}>
            {runs.length === 0 && <option value="">차수 없음</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        )}
        {def.scope === 'range' && (
          <>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={field}
            />
            <span className="text-neutral-400">~</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
          </>
        )}
        {def.scope === 'annual' && (
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className={field}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={busy || (def.scope === 'period' && !runId)}
          onClick={() => onRun(def, { runId, from, to, year }, 'view')}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          보기
        </button>
        <button
          disabled={busy || (def.scope === 'period' && !runId)}
          onClick={() => onRun(def, { runId, from, to, year }, 'download')}
          className={primary}
        >
          다운로드
        </button>
      </div>
    </div>
  );
}
