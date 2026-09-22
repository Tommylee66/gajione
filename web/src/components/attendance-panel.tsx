'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  uploadPunchesAction,
  rebuildRangeAction,
  resolveAnomalyAction,
  confirmPeriodAction,
  type UploadResult,
} from '@/app/attendance/actions';
import type { AnomalyRow } from '@/lib/data-access/attendance';
import type { GateCheck } from '@/lib/attendance/build-days';
import { PUNCH_CSV_TEMPLATE } from '@/lib/attendance/csv';

const ANOMALY_LABELS: Record<string, string> = {
  missing_check_out: '퇴근기록 누락',
  missing_check_in: '출근기록 누락',
  late: '지각',
  early_leave: '조퇴',
  leave_overlap: '연차·출근 중복',
  no_schedule: '스케줄 없는 기록',
};

interface Props {
  from: string;
  to: string;
  gate: GateCheck[];
  anomalies: (AnomalyRow & { employee_name: string; employee_no: string })[];
  canEdit: boolean;
}

export function AttendancePanel({ from, to, gate, anomalies, canEdit }: Props) {
  const router = useRouter();
  const [result, setResult] = useState<UploadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const open = anomalies.filter((a) => a.status === 'open');
  const blocked = gate.some((c) => c.blocking && !c.passed);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = new FormData(e.currentTarget).get('file') as File | null;
    if (!file || file.size === 0) return;
    setBusy(true);
    setResult(null);
    const text = await file.text();
    setResult(await uploadPunchesAction(text, from, to));
    setBusy(false);
    router.refresh();
  }

  function downloadTemplate() {
    const blob = new Blob([PUNCH_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'punch-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mt-8 space-y-10">
      <section>
        <h2 className="text-lg font-semibold">G1 · 근태 무결성</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {gate.map((c) => (
            <div
              key={c.code}
              className={`rounded-lg border p-3 ${
                c.passed
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : c.blocking
                    ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950'
                    : 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{c.label}</span>
                <span className="text-xs">
                  {c.passed ? '통과' : c.blocking ? '차단' : '경고'}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{c.detail}</p>
            </div>
          ))}
        </div>

        {canEdit && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              disabled={pending || blocked}
              onClick={() =>
                startTransition(async () => {
                  setConfirmError(null);
                  const r = await confirmPeriodAction(from, to);
                  if (!r.ok) setConfirmError(r.error ?? '마감에 실패했습니다.');
                  router.refresh();
                })
              }
              className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              근태 마감 (G1 통과)
            </button>
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setResult(await rebuildRangeAction(from, to));
                  router.refresh();
                })
              }
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              재집계
            </button>
            {blocked && (
              <span className="text-sm text-neutral-500">
                차단 항목이 남아 있어 마감할 수 없습니다.
              </span>
            )}
          </div>
        )}
        {confirmError && <p className="mt-2 text-sm text-red-600">{confirmError}</p>}
      </section>

      {canEdit && (
        <section>
          <h2 className="text-lg font-semibold">지문기 기록 업로드</h2>
          <p className="mt-1 text-sm text-neutral-500">
            CSV 컬럼: <code>employee_no, punched_at, direction, device_code</code> · 시각은
            현지시간(WIB) 기준 <code>YYYY-MM-DD HH:MM[:SS]</code>
          </p>

          <form onSubmit={onUpload} className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="text-sm"
            />
            <button
              disabled={busy}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? '처리 중…' : '업로드'}
            </button>
            <button
              type="button"
              onClick={downloadTemplate}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              템플릿 받기
            </button>
          </form>

          {result && <UploadReport result={result} />}
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">이상근태</h2>
          <p className="text-sm text-neutral-500">
            미해결 {open.length}건 · 전체 {anomalies.length}건
          </p>
        </div>

        {anomalies.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">이 기간에 이상근태가 없습니다.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {anomalies.map((a) => (
              <AnomalyCard key={a.id} anomaly={a} canEdit={canEdit} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function UploadReport({ result }: { result: UploadResult }) {
  if (!result.ok) {
    return (
      <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950">
        <p className="font-medium text-red-800 dark:text-red-200">{result.error}</p>
        {result.parseErrors && result.parseErrors.length > 0 && (
          <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
            {result.parseErrors.map((e) => (
              <li key={e.lineNo}>
                <span className="font-mono">{e.lineNo}행</span> — {e.reason}
              </li>
            ))}
          </ul>
        )}
        {result.unknownEmployees && result.unknownEmployees.length > 0 && (
          <p className="mt-2 text-red-700 dark:text-red-300">
            등록되지 않은 사번: {result.unknownEmployees.join(', ')}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <p>
        {result.inserted !== undefined && <>기록 {result.inserted}건 저장 · </>}
        일별 {result.daysWritten ?? 0}건 집계 · 이상근태 {result.anomaliesFound ?? 0}건 검출
      </p>
      {(result.daysSkippedConfirmed ?? 0) > 0 && (
        <p className="mt-1 text-neutral-500">
          이미 마감된 {result.daysSkippedConfirmed}건은 덮어쓰지 않았습니다.
        </p>
      )}
    </div>
  );
}

function AnomalyCard({
  anomaly,
  canEdit,
}: {
  anomaly: AnomalyRow & { employee_name: string; employee_no: string };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = anomaly.status !== 'open';

  async function onResolve(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const r = await resolveAnomalyAction(
      anomaly.id,
      String(fd.get('resolution') ?? ''),
      fd.get('waive') === 'on'
    );
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
    <div
      className={`rounded-lg border p-4 ${
        resolved
          ? 'border-neutral-200 dark:border-neutral-800'
          : 'border-amber-300 dark:border-amber-900'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {anomaly.employee_no} {anomaly.employee_name}
            <span className="ml-2 text-neutral-500">{anomaly.work_date}</span>
          </p>
          <p className="mt-1 text-sm">
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
              {ANOMALY_LABELS[anomaly.anomaly_type] ?? anomaly.anomaly_type}
            </span>
            <span className="ml-2 text-neutral-600 dark:text-neutral-400">{anomaly.detail}</span>
          </p>
          {anomaly.resolution && (
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              처리: {anomaly.resolution}
              {anomaly.status === 'waived' && ' (예외 처리)'}
            </p>
          )}
        </div>
        {canEdit && !resolved && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            {open ? '취소' : '소명 처리'}
          </button>
        )}
        {resolved && <span className="text-xs text-neutral-500">해결</span>}
      </div>

      {open && (
        <form onSubmit={onResolve} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block flex-1">
            <span className="text-xs font-medium text-neutral-500">처리 내용 · 근거</span>
            <input
              name="resolution"
              required
              placeholder="지문기#7 로그 보정 · CCTV 교차확인"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="waive" />
            예외 처리
          </label>
          <button
            disabled={busy}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            저장
          </button>
          {error && <p className="w-full text-sm text-red-600">{error}</p>}
        </form>
      )}
    </div>
  );
}
