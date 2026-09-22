'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  evaluateGateAction,
  submitExplanationAction,
  decideVarianceAction,
  passG3Action,
} from '@/app/payroll/gate-actions';
import { formatRupiah } from '@/lib/format';

export interface StoredGateResult {
  rule_code: string;
  passed: boolean;
  severity: 'blocking' | 'warning';
  detail: { message?: string; offenders?: string[] } | null;
}

export interface VarianceCase {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  prev_net: number;
  curr_net: number;
  change_rate: number;
  line_comment: string | null;
  line_submitted_at: string | null;
  hr_decision: string | null;
  hr_comment: string | null;
  hr_decided_at: string | null;
  status: string;
}

const RULE_NAMES: Record<string, string> = {
  G2_SUM_RECONCILE: '구성합계 = 총계 대사',
  G2_NET_POSITIVE: '음수·0원 급여 없음',
  G2_RECALC_MATCH: '병렬 재계산 일치',
  G2_RATE_VERSION: '요율 버전 고정',
  G2_UMK_FLOOR: 'UMK 미달 검사',
  G3_LOAN_CAP: '대출 공제 상한',
  G3_NET_VARIANCE: '순지급 변동 검출',
};

interface Props {
  runId: string;
  runStatus: string;
  results: StoredGateResult[];
  cases: VarianceCase[];
  canRun: boolean;
  canExplain: boolean;
  canDecide: boolean;
}

export function GatePanel({
  runId,
  runStatus,
  results,
  cases,
  canRun,
  canExplain,
  canDecide,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passedCount = results.filter((r) => r.passed).length;
  const open = cases.filter((c) => c.status === 'pending' || c.status === 'explained');
  const rejected = cases.filter((c) => c.status === 'rejected');
  const blockingFailures = results.filter(
    (r) => r.severity === 'blocking' && !r.passed && r.rule_code !== 'G3_NET_VARIANCE'
  );
  const canClose =
    results.length > 0 && blockingFailures.length === 0 && open.length === 0 && rejected.length === 0;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">G3 · 검증·소명</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {results.length > 0
              ? `자동 규칙 ${results.length}건 중 ${passedCount}건 통과`
              : '아직 평가하지 않았습니다.'}
          </p>
        </div>
        {canRun && (
          <div className="flex gap-2">
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  setMessage(null);
                  const r = await evaluateGateAction(runId);
                  if (!r.ok) setError(r.error ?? '평가에 실패했습니다.');
                  else
                    setMessage(
                      `규칙 ${r.rulesPassed}/${r.rulesTotal} 통과 · 소명 대상 ${r.variances}명`
                    );
                  router.refresh();
                })
              }
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
            >
              규칙 평가
            </button>
            <button
              disabled={pending || !canClose || runStatus === 'g3_passed'}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const r = await passG3Action(runId);
                  if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
                  router.refresh();
                })
              }
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {runStatus === 'g3_passed' ? 'G3 통과됨' : 'G3 통과 처리'}
            </button>
          </div>
        )}
      </div>

      {message && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {results.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {results.map((r) => (
            <div
              key={r.rule_code}
              className={`rounded-lg border p-3 ${
                r.passed
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : r.severity === 'blocking'
                    ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950'
                    : 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {RULE_NAMES[r.rule_code] ?? r.rule_code}
                </span>
                <span className="text-xs">
                  {r.passed ? '통과' : r.severity === 'blocking' ? '차단' : '경고'}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {r.detail?.message ?? '—'}
              </p>
              {r.detail?.offenders && r.detail.offenders.length > 0 && (
                <p className="mt-1 font-mono text-xs text-neutral-500">
                  {r.detail.offenders.slice(0, 8).join(', ')}
                  {r.detail.offenders.length > 8 && ` 외 ${r.detail.offenders.length - 8}명`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {cases.length > 0 && (
        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold">변동 소명</h3>
            <p className="text-sm text-neutral-500">
              대기 {open.length}건 · 승인 {cases.filter((c) => c.status === 'approved').length}건
              {rejected.length > 0 && ` · 반려 ${rejected.length}건`}
            </p>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            라인장이 1차 소명하고 HR이 2차 승인합니다. 자동 규칙이 대신할 수 없는 판단이라 두
            사람의 기록이 각각 남습니다.
          </p>
          <div className="mt-3 space-y-3">
            {cases.map((c) => (
              <CaseCard key={c.id} item={c} canExplain={canExplain} canDecide={canDecide} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CaseCard({
  item,
  canExplain,
  canDecide,
}: {
  item: VarianceCase;
  canExplain: boolean;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const awaitingExplanation = !item.line_submitted_at;
  const awaitingDecision = Boolean(item.line_submitted_at) && item.status === 'explained';

  async function explain(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const r = await submitExplanationAction(item.id, String(fd.get('comment') ?? ''));
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '처리에 실패했습니다.');
    router.refresh();
  }

  async function decide(e: React.FormEvent<HTMLFormElement>, decision: 'approved' | 'rejected' | 'returned') {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = (e.currentTarget as HTMLFormElement).closest('form') ?? e.currentTarget;
    const comment = String(new FormData(form as HTMLFormElement).get('hr_comment') ?? '');
    const r = await decideVarianceAction(item.id, decision, comment);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '처리에 실패했습니다.');
    router.refresh();
  }

  const statusLabel =
    item.status === 'approved'
      ? '승인'
      : item.status === 'rejected'
        ? '반려'
        : item.status === 'explained'
          ? 'HR 승인 대기'
          : '라인장 소명 대기';

  return (
    <div
      className={`rounded-lg border p-4 ${
        item.status === 'approved'
          ? 'border-neutral-200 dark:border-neutral-800'
          : item.status === 'rejected'
            ? 'border-red-300 dark:border-red-900'
            : 'border-amber-300 dark:border-amber-900'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {item.employee_no} {item.employee_name}
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {formatRupiah(item.prev_net)} → {formatRupiah(item.curr_net)}{' '}
            <span className={item.change_rate >= 0 ? 'text-blue-600' : 'text-red-600'}>
              ({item.change_rate >= 0 ? '+' : ''}
              {item.change_rate.toFixed(1)}%)
            </span>
          </p>
        </div>
        <span className="text-xs text-neutral-500">{statusLabel}</span>
      </div>

      {item.line_comment && (
        <p className="mt-3 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
          <span className="text-xs text-neutral-500">라인장 소명</span>
          <br />
          {item.line_comment}
        </p>
      )}
      {item.hr_comment && (
        <p className="mt-2 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
          <span className="text-xs text-neutral-500">HR 판단 ({item.hr_decision})</span>
          <br />
          {item.hr_comment}
        </p>
      )}

      {canExplain && awaitingExplanation && (
        <form onSubmit={explain} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block flex-1">
            <span className="text-xs font-medium text-neutral-500">1차 소명 (라인장)</span>
            <input
              name="comment"
              required
              placeholder="승진으로 기본급 인상 · 8월 1일 효력"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            disabled={busy}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            소명 제출
          </button>
        </form>
      )}

      {canDecide && awaitingDecision && (
        <form className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block flex-1">
            <span className="text-xs font-medium text-neutral-500">2차 판단 (HR)</span>
            <input
              name="hr_comment"
              placeholder="인사 발령 확인함"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            disabled={busy}
            onClick={(e) => decide(e as unknown as React.FormEvent<HTMLFormElement>, 'approved')}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            승인
          </button>
          <button
            disabled={busy}
            onClick={(e) => decide(e as unknown as React.FormEvent<HTMLFormElement>, 'returned')}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-60"
          >
            재소명 요청
          </button>
          <button
            disabled={busy}
            onClick={(e) => decide(e as unknown as React.FormEvent<HTMLFormElement>, 'rejected')}
            className="rounded-md px-3 py-2 text-sm text-red-600 underline disabled:opacity-60"
          >
            반려
          </button>
        </form>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
