'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  uploadBatchAction,
  applyBatchAction,
  discardBatchAction,
  errorCsvAction,
} from '@/app/upload/actions';
import {
  TEMPLATE_COLUMNS,
  CORE_COLUMNS,
  buildTemplateCsv,
} from '@/lib/upload/pph21-template';

const primary =
  'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';
const secondary =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-neutral-700';

export interface BatchRow {
  id: string;
  period: string;
  filename: string | null;
  uploader: string | null;
  created_at: string;
  row_count: number;
  error_count: number;
  status: string;
  created_employees: number;
  updated_employees: number;
}

export interface PreviewRow {
  row_no: number;
  employee_number: string | null;
  data: Record<string, string>;
  errors: string[];
}

const STATUS_LABELS: Record<string, string> = {
  parsed: '검토 대기',
  applied: '적용 완료',
  discarded: '폐기',
};

function download(filename: string, text: string) {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function UploadPanel({
  batches,
  preview,
  previewBatch,
  canAct,
}: {
  batches: BatchRow[];
  preview: PreviewRow[];
  previewBatch: BatchRow | null;
  canAct: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const now = new Date();
  const [period, setPeriod] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );

  async function handleFile(file: File) {
    setBusy(true);
    setNote(null);
    setError(null);
    setMissing([]);
    if (!/\.csv$/i.test(file.name)) {
      setBusy(false);
      // xlsx would need a parser in the browser; saying so is better than a
      // silent failure on a file the user believes was accepted.
      return setError('.csv 파일만 지원합니다. xlsx는 CSV로 저장한 뒤 올려주세요.');
    }
    const text = await file.text();
    const r = await uploadBatchAction({ period, filename: file.name, csvText: text });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? '업로드에 실패했습니다.');
      setMissing(r.missingColumns ?? []);
      return;
    }
    setNote(
      `${r.total}행 · 오류 ${r.errors}건${r.warnings ? ` · 경고 ${r.warnings}건` : ''}` +
        (r.extraColumns && r.extraColumns.length > 0
          ? ` · 템플릿에 없는 컬럼 ${r.extraColumns.length}개는 무시됩니다`
          : '')
    );
    router.push(`/upload?batch=${r.batchId}`);
    router.refresh();
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string; created?: number; updated?: number }>) {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
    else if (r.created !== undefined)
      setNote(`직원 ${r.created}명 신규 · ${r.updated}명 갱신했습니다.`);
    else setNote('처리했습니다.');
    router.refresh();
  }

  const columns = showAll ? [...TEMPLATE_COLUMNS] : [...CORE_COLUMNS];
  const errorRows = preview.filter((p) => p.errors.some((e) => !e.startsWith('[경고]'))).length;
  const canApply =
    previewBatch !== null &&
    previewBatch.status === 'parsed' &&
    previewBatch.error_count === 0 &&
    preview.length > 0;

  return (
    <>
      {note && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{note}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {missing.length > 0 && (
        <p className="mt-1 font-mono text-xs text-red-600">
          없는 컬럼: {missing.slice(0, 10).join(', ')}
          {missing.length > 10 && ` 외 ${missing.length - 10}개`}
        </p>
      )}

      {/* --- ① 템플릿 --------------------------------------------------- */}
      <section className="mt-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">① 템플릿 내려받기</h2>
        <p className="mt-1 text-sm text-neutral-500">
          PPh 21 원천징수 계산에 필요한 {TEMPLATE_COLUMNS.length}개 항목. 예시 1행이 포함되어
          있으니 형식을 확인하고 지운 뒤 작성하세요.
        </p>
        <button
          onClick={() => download('pph21_upload_template.csv', buildTemplateCsv())}
          className={`mt-3 ${secondary}`}
        >
          템플릿 다운로드 (CSV)
        </button>
      </section>

      {/* --- ② 업로드 --------------------------------------------------- */}
      {canAct && (
        <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-base font-semibold">② 업로드</h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs text-neutral-500">차수</span>
              <input
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="2026-09"
                className="mt-1 block w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
              className="text-sm"
            />
          </div>
          <p className="mt-2 text-xs text-neutral-500">지원 형식: .csv · 최대 10MB</p>
        </section>
      )}

      {/* --- ③ 파싱 미리보기 -------------------------------------------- */}
      <section className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">③ 파싱 미리보기</h2>
          {previewBatch && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setShowAll((v) => !v)} className={secondary}>
                {showAll ? '핵심 컬럼만 보기' : `전체 ${TEMPLATE_COLUMNS.length}개 컬럼 보기`}
              </button>
              {errorRows > 0 && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    const r = await errorCsvAction(previewBatch.id);
                    if (!r.ok) return setError(r.error ?? '생성에 실패했습니다.');
                    download(`upload_errors_${previewBatch.period}.csv`, r.csv!);
                  }}
                  className={secondary}
                >
                  오류 행만 다운로드
                </button>
              )}
              {canAct && (
                <button
                  disabled={busy || !canApply}
                  onClick={() => run(() => applyBatchAction(previewBatch.id))}
                  className={primary}
                >
                  직원 마스터에 적용
                </button>
              )}
            </div>
          )}
        </div>

        {!previewBatch ? (
          <p className="mt-2 text-sm text-neutral-500">
            아직 선택된 업로드가 없습니다. 템플릿을 작성해 올리거나, 아래 이력에서 하나를
            고르세요.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-neutral-500">
              {previewBatch.period} · {previewBatch.filename ?? '—'} · 총 {previewBatch.row_count}행
              · 정상 {previewBatch.row_count - previewBatch.error_count} · 오류{' '}
              <span className={previewBatch.error_count > 0 ? 'text-red-600' : ''}>
                {previewBatch.error_count}건
              </span>
            </p>
            {previewBatch.error_count > 0 && (
              /* The gate: a batch with any failed row cannot touch the master. */
              <p className="mt-1 text-sm text-red-600">
                오류를 모두 해결해야 직원 마스터에 적용할 수 있습니다.
              </p>
            )}
            {previewBatch.status === 'applied' && (
              <p className="mt-1 text-sm text-neutral-500">
                적용 완료 · 신규 {previewBatch.created_employees}명 · 갱신{' '}
                {previewBatch.updated_employees}명
              </p>
            )}

            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-sm" style={{ minWidth: showAll ? 2600 : 860 }}>
                <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                  <tr>
                    <th className="px-3 py-2 font-medium">#</th>
                    {columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((p) => {
                    const errs = p.errors.filter((e) => !e.startsWith('[경고]'));
                    const warns = p.errors.filter((e) => e.startsWith('[경고]'));
                    return (
                      <tr
                        key={p.row_no}
                        className={`border-t border-neutral-200 dark:border-neutral-800 ${
                          errs.length > 0 ? 'bg-red-50 dark:bg-red-950' : ''
                        }`}
                      >
                        <td className="px-3 py-2 text-neutral-500">{p.row_no}</td>
                        {columns.map((c) => (
                          <td key={c} className="whitespace-nowrap px-3 py-2">
                            {p.data[c] || <span className="text-neutral-400">—</span>}
                          </td>
                        ))}
                        <td className="px-3 py-2">
                          {errs.length > 0 ? (
                            <>
                              <span className="text-red-600">오류</span>
                              <div className="mt-1 text-xs text-red-600">{errs.join(' · ')}</div>
                            </>
                          ) : warns.length > 0 ? (
                            <>
                              <span className="text-amber-600">경고</span>
                              <div className="mt-1 text-xs text-amber-600">
                                {warns.map((w) => w.replace('[경고] ', '')).join(' · ')}
                              </div>
                            </>
                          ) : (
                            <span className="text-neutral-500">정상</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {preview.length < previewBatch.row_count && (
              <p className="mt-2 text-xs text-neutral-500">
                {preview.length}행만 표시했습니다 (총 {previewBatch.row_count}행).
              </p>
            )}
          </>
        )}
      </section>

      {/* --- 업로드 이력 ------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">업로드 이력</h2>
        {batches.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">업로드 기록이 없습니다.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">차수</th>
                  <th className="px-3 py-2 font-medium">파일</th>
                  <th className="px-3 py-2 font-medium">업로드자</th>
                  <th className="px-3 py-2 font-medium">시각</th>
                  <th className="px-3 py-2 text-right font-medium">행수</th>
                  <th className="px-3 py-2 text-right font-medium">오류</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">{b.period}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {b.filename ?? '—'}
                    </td>
                    <td className="px-3 py-2">{b.uploader ?? '—'}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {new Date(b.created_at).toLocaleString('ko-KR', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{b.row_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={b.error_count > 0 ? 'text-red-600' : ''}>
                        {b.error_count}
                      </span>
                    </td>
                    <td className="px-3 py-2">{STATUS_LABELS[b.status] ?? b.status}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/upload?batch=${b.id}`} className="text-sm text-blue-600 underline">
                        보기
                      </Link>
                      {canAct && b.status === 'parsed' && (
                        <button
                          disabled={busy}
                          onClick={() => run(() => discardBatchAction(b.id))}
                          className="ml-3 text-sm text-neutral-500 underline disabled:opacity-50"
                        >
                          폐기
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
