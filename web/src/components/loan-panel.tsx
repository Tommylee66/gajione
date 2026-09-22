'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  scoreEmployeesAction,
  grantConsentAction,
  revokeConsentAction,
  referAction,
  recordLenderDecisionAction,
  createMandateAction,
  setMandateStatusAction,
} from '@/app/loans/actions';
import { formatRupiah } from '@/lib/format';
import {
  BAND_LABELS,
  MANDATE_STATUS_LABELS,
  REFERRAL_STATUS_LABELS,
  type Assessment,
} from '@/lib/credit/scoring';

export interface ScoreDetailView {
  factor_name: string;
  weight: number;
  raw_metric: string;
  normalized: number;
  points: number;
}

export interface ReferralView {
  id: string;
  employee_id: string;
  lender_id: string;
  employee_no: string;
  employee_name: string;
  department: string | null;
  product_label: string | null;
  amount_requested: number;
  months: number;
  status: string;
  lender_decision: string | null;
  lender_ref_no: string | null;
  decline_reason: string | null;
  lender_name: string;
  score: number | null;
  scoredAt: string | null;
  details: ScoreDetailView[];
  consentScope: string | null;
  consentId: string | null;
  assessment: Assessment;
  hasMandate: boolean;
}

export interface MandateView {
  id: string;
  employee_no: string;
  employee_name: string;
  lender_name: string;
  monthly_amount: number;
  total_installments: number;
  paid_installments: number;
  balance: number | null;
  mirror_synced_at: string | null;
  is_overdue: boolean;
  status: string;
  start_period: string;
  thisPeriodAmount: number | null;
}

const SCOPE_LABELS: Record<string, string> = {
  score_only: '신용점수만',
  score_and_tenure: '신용점수·근속',
  full_payroll: '급여 전체',
};

interface Props {
  referrals: ReferralView[];
  mandates: MandateView[];
  lenders: { id: string; name: string; ojk_license_no: string | null; status: string }[];
  lockedRuns: { id: string; period: string }[];
  canAct: boolean;
}

export function LoanPanel({ referrals, mandates, lenders, lockedRuns, canAct }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(lockedRuns[0]?.id ?? '');

  function run(fn: () => Promise<{ ok: boolean; error?: string; scored?: number }>, ok: string) {
    startTransition(async () => {
      setError(null);
      setMessage(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
      else setMessage(r.scored !== undefined ? `${r.scored}명 산출 완료` : ok);
      router.refresh();
    });
  }

  const queue = referrals.filter((r) => r.status === 'draft' || r.status === 'referred');
  const decided = referrals.filter((r) => r.status === 'approved' || r.status === 'rejected');

  return (
    <>
      {message && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* --- 신용점수 산출 --------------------------------------------------- */}
      {canAct && (
        <section className="mt-6 flex flex-wrap items-end justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="text-base font-semibold">신용점수 산출</h2>
            {/* Off a closed run, not "now": a lender reading a profile has to
                see the same number tomorrow. */}
            <p className="mt-1 text-sm text-neutral-500">
              마감된 차수의 확정 데이터로만 산출합니다.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="text-xs text-neutral-500">기준 차수</span>
              <select
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                className="mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              >
                {lockedRuns.length === 0 && <option value="">마감된 차수 없음</option>}
                {lockedRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.period}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={pending || !runId}
              onClick={() => run(() => scoreEmployeesAction(runId), '산출 완료')}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              전 직원 산출
            </button>
          </div>
        </section>
      )}

      {/* --- 심사 큐 -------------------------------------------------------- */}
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">대출 심사 큐</h2>
          <p className="text-sm text-neutral-500">
            한도 = 월실수령 2배 · 공제상한 = 실지급 30%
          </p>
        </div>
        {queue.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">심사 대기 중인 신청이 없습니다.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {queue.map((r) => (
              <ReferralCard key={r.id} item={r} canAct={canAct} onRun={run} pending={pending} />
            ))}
          </div>
        )}
      </section>

      {/* --- 금융기관 결과 --------------------------------------------------- */}
      {decided.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">금융기관 결과</h2>
          <div className="mt-3 space-y-2">
            {decided.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
              >
                <div>
                  <p className="text-sm font-medium">
                    {r.employee_no} {r.employee_name} · {formatRupiah(r.amount_requested)} /{' '}
                    {r.months}회
                  </p>
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {r.lender_name} · {REFERRAL_STATUS_LABELS[r.status] ?? r.status}
                    {r.lender_ref_no && ` · ${r.lender_ref_no}`}
                    {r.decline_reason && ` · ${r.decline_reason}`}
                  </p>
                </div>
                {canAct && r.status === 'approved' && !r.hasMandate && (
                  <MandateForm id={r.id} onRun={run} pending={pending} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* --- 상환 원장 ------------------------------------------------------ */}
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">상환 원장</h2>
          {/* The balance column comes from the lender's book, not ours. It is
              labelled as a mirror because it will sometimes be stale, and
              showing it as our own figure would be a claim we cannot stand behind. */}
          <p className="text-sm text-neutral-500">잔액은 금융기관 원장 사본입니다</p>
        </div>
        {mandates.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">등록된 급여공제가 없습니다.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">차입자</th>
                  <th className="px-3 py-2 font-medium">금융기관</th>
                  <th className="px-3 py-2 font-medium">진행</th>
                  <th className="px-3 py-2 text-right font-medium">잔액</th>
                  <th className="px-3 py-2 text-right font-medium">월공제</th>
                  <th className="px-3 py-2 text-right font-medium">이번 차수</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  {canAct && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {mandates.map((m) => (
                  <tr key={m.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">
                      {m.employee_no} {m.employee_name}
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {m.lender_name}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {m.paid_installments}/{m.total_installments}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.balance === null ? (
                        <span className="text-neutral-400">미동기화</span>
                      ) : (
                        formatRupiah(m.balance)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatRupiah(m.monthly_amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.thisPeriodAmount === null ? '—' : formatRupiah(m.thisPeriodAmount)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={m.is_overdue ? 'text-red-600' : ''}>
                        {m.is_overdue ? '연체' : (MANDATE_STATUS_LABELS[m.status] ?? m.status)}
                      </span>
                    </td>
                    {canAct && (
                      <td className="px-3 py-2 text-right">
                        {m.status === 'active' ? (
                          <button
                            disabled={pending}
                            onClick={() =>
                              run(() => setMandateStatusAction(m.id, 'suspended'), '유예 처리했습니다.')
                            }
                            className="text-sm text-blue-600 underline disabled:opacity-50"
                          >
                            유예
                          </button>
                        ) : m.status === 'suspended' ? (
                          <button
                            disabled={pending}
                            onClick={() =>
                              run(() => setMandateStatusAction(m.id, 'active'), '재개했습니다.')
                            }
                            className="text-sm text-blue-600 underline disabled:opacity-50"
                          >
                            재개
                          </button>
                        ) : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- 제휴 금융기관 --------------------------------------------------- */}
      <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">제휴 금융기관</h2>
        {/* The boundary, stated on the screen and not only in the contract. */}
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          대출 실행은 인가받은 금융기관이 합니다. GajiOne은 신용 프로필 산출과 전달, 급여공제
          집행과 대사만 담당하며 금리 제안·자금 실행·상환 스케줄 등록에는 관여하지 않습니다.
        </p>
        {lenders.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">등록된 제휴사가 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {lenders.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{l.name}</span>
                <span className="text-neutral-500">
                  OJK {l.ojk_license_no ?? '미등록'} · {l.status === 'active' ? '정상' : l.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ConsentNote referrals={referrals} canAct={canAct} onRun={run} pending={pending} />
      </section>
    </>
  );
}

function ReferralCard({
  item,
  canAct,
  onRun,
  pending,
}: {
  item: ReferralView;
  canAct: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const a = item.assessment;
  const tone =
    a.outcome === 'auto'
      ? 'border-neutral-200 dark:border-neutral-800'
      : a.outcome === 'manual'
        ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
        : 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950';

  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {item.employee_no} {item.employee_name}
            {item.department && (
              <span className="text-neutral-500"> · {item.department}</span>
            )}
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {formatRupiah(item.amount_requested)} · {item.product_label ?? '일반'} {item.months}회차
            · 월공제 {formatRupiah(a.monthlyInstalment)} ({a.instalmentRatePercent.toFixed(1)}%)
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">
            {item.score ?? '—'}
            <span className="text-sm font-normal text-neutral-500"> / 850</span>
          </p>
          <p className="text-xs text-neutral-500">
            {item.score === null ? '점수 미산출' : BAND_LABELS[a.band]}
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
        {a.reasons.map((r) => (
          <li key={r}>· {r}</li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-neutral-500">
          {item.consentScope
            ? `정보제공 동의: ${SCOPE_LABELS[item.consentScope] ?? item.consentScope}`
            : '정보제공 동의 없음'}
        </span>
        {item.details.length > 0 && (
          <button onClick={() => setOpen((v) => !v)} className="text-blue-600 underline">
            {open ? '산출 내역 닫기' : '산출 내역'}
          </button>
        )}
        <span className="ml-auto text-neutral-500">
          {REFERRAL_STATUS_LABELS[item.status] ?? item.status} · {item.lender_name}
        </span>
      </div>

      {open && (
        <div className="mt-3 overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">항목</th>
                <th className="px-3 py-2 font-medium">원자료</th>
                <th className="px-3 py-2 text-right font-medium">정규화</th>
                <th className="px-3 py-2 text-right font-medium">기여</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">기본점수</td>
                <td className="px-3 py-2 text-neutral-500">고정 시작점</td>
                <td className="px-3 py-2 text-right">—</td>
                <td className="px-3 py-2 text-right tabular-nums">+300</td>
              </tr>
              {item.details.map((d) => (
                <tr key={d.factor_name} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">
                    {d.factor_name} <span className="text-neutral-500">{d.weight}%</span>
                  </td>
                  <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{d.raw_metric}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{d.normalized.toFixed(0)}/100</td>
                  <td className="px-3 py-2 text-right tabular-nums">+{d.points}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-200 font-medium dark:border-neutral-800">
                <td className="px-3 py-2" colSpan={3}>
                  합계
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{item.score}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {canAct && item.status === 'draft' && !item.consentId && (
        <ConsentForm
          employeeId={item.employee_id}
          lenderId={item.lender_id}
          onRun={onRun}
          pending={pending}
        />
      )}

      {canAct && item.status === 'draft' && item.consentId && (
        <ReferForm
          id={item.id}
          outcome={a.outcome}
          onRun={onRun}
          pending={pending}
        />
      )}

      {canAct && item.status === 'referred' && (
        <DecisionForm id={item.id} onRun={onRun} pending={pending} />
      )}
    </div>
  );
}

/**
 * A manual-band application cannot be sent without a written reason.
 *
 * The band is the whole point of the band: without this the label is
 * decoration and an application well past the deduction ceiling goes to the
 * lender the same way a clean one does.
 */
function ReferForm({
  id,
  outcome,
  onRun,
  pending,
}: {
  id: string;
  outcome: 'auto' | 'manual' | 'declined';
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const [note, setNote] = useState('');
  if (outcome === 'declined') {
    return (
      <p className="mt-3 text-sm text-neutral-500">기준 미달이라 전달할 수 없습니다.</p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      {outcome === 'manual' && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="수동심사 검토 사유 (필수)"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      )}
      <button
        disabled={pending || (outcome === 'manual' && !note.trim())}
        onClick={() => onRun(() => referAction(id, note), '금융기관에 전달했습니다.')}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {outcome === 'manual' ? '검토 후 전달' : '금융기관 전달'}
      </button>
    </div>
  );
}

function DecisionForm({
  id,
  onRun,
  pending,
}: {
  id: string;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const [refNo, setRefNo] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <p className="w-full text-xs text-neutral-500">
        금융기관이 통보한 결과를 그대로 기록합니다. 심사 자체는 금융기관이 합니다.
      </p>
      <input
        value={refNo}
        onChange={(e) => setRefNo(e.target.value)}
        placeholder="금융기관 참조번호"
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="거절 사유 (거절 시)"
        className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <button
        disabled={pending}
        onClick={() =>
          onRun(() => recordLenderDecisionAction(id, 'approved', refNo, note), '승인으로 기록했습니다.')
        }
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        승인 기록
      </button>
      <button
        disabled={pending}
        onClick={() =>
          onRun(() => recordLenderDecisionAction(id, 'rejected', refNo, note), '거절로 기록했습니다.')
        }
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
      >
        거절 기록
      </button>
    </div>
  );
}

function MandateForm({
  id,
  onRun,
  pending,
}: {
  id: string;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const now = new Date();
  const [period, setPeriod] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );
  return (
    <div className="flex items-end gap-2">
      <label className="block">
        <span className="text-xs text-neutral-500">공제 시작 차수</span>
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          placeholder="2026-09"
          className="mt-1 block w-28 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      <button
        disabled={pending}
        onClick={() => onRun(() => createMandateAction(id, period), '급여공제를 등록했습니다.')}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        급여공제 등록
      </button>
    </div>
  );
}

/**
 * Consent is captured before anything is sent, not alongside it.
 *
 * Sending someone's tenure, attendance and score to a lender is disclosure of
 * personal data to a third party, and evidence_ref is required because a
 * consent nobody can produce the record of is not evidence of consent.
 */
function ConsentForm({
  employeeId,
  lenderId,
  onRun,
  pending,
}: {
  employeeId: string;
  lenderId: string;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const [scope, setScope] = useState<'score_only' | 'score_and_tenure' | 'full_payroll'>(
    'score_and_tenure'
  );
  const [evidence, setEvidence] = useState('');
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <p className="w-full text-xs text-neutral-500">
        정보제공 동의가 없어 전달할 수 없습니다. 동의 범위와 근거를 먼저 기록하세요.
      </p>
      <label className="block">
        <span className="text-xs text-neutral-500">범위</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
          className="mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="score_only">신용점수만</option>
          <option value="score_and_tenure">신용점수·근속</option>
          <option value="full_payroll">급여 전체</option>
        </select>
      </label>
      <input
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="동의 근거 (서명 양식 번호·앱 동의 기록 ID)"
        className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <button
        disabled={pending}
        onClick={() =>
          onRun(
            () => grantConsentAction(employeeId, lenderId, scope, evidence),
            '동의를 기록했습니다.'
          )
        }
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
      >
        동의 기록
      </button>
    </div>
  );
}

function ConsentNote({
  referrals,
  canAct,
  onRun,
  pending,
}: {
  referrals: ReferralView[];
  canAct: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  pending: boolean;
}) {
  const live = referrals.filter((r) => r.consentId);
  if (live.length === 0) return null;
  return (
    <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <p className="text-sm font-medium">정보제공 동의 현황</p>
      {/* Withdrawable, because consent that cannot be withdrawn is not consent
          (UU PDP art. 20). */}
      <ul className="mt-2 space-y-1 text-sm">
        {live.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {r.employee_no} {r.employee_name} → {r.lender_name} ·{' '}
              {SCOPE_LABELS[r.consentScope ?? ''] ?? r.consentScope}
            </span>
            {canAct && (
              <button
                disabled={pending}
                onClick={() => onRun(() => revokeConsentAction(r.consentId!), '동의를 철회했습니다.')}
                className="text-sm text-red-600 underline disabled:opacity-50"
              >
                철회
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
