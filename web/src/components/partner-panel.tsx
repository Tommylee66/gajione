'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  sendOfferAction,
  withdrawOfferAction,
  declineReferralAction,
  recordDisbursementAction,
} from '@/app/partner/actions';
import { formatRupiah } from '@/lib/format';
import {
  buildSchedule,
  offerStages,
  validateOffer,
  REPAYMENT_LABELS,
  OFFER_STATUS_LABELS,
  type RepaymentMethod,
} from '@/lib/credit/offer';
import { BAND_LABELS, band } from '@/lib/credit/scoring';

const primary =
  'rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';
const secondary =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-neutral-700';
const field =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export interface ProfileSnapshot {
  employee_no?: string | null;
  employer?: string | null;
  scope?: string | null;
  tenure_years?: number | null;
  employment_type?: string | null;
  attendance?: string | null;
  repayment?: string | null;
  pay_stability?: string | null;
}

export interface OfferView {
  id: string;
  annual_rate: number;
  months: number;
  fee_percent: number;
  repayment_method: string;
  monthly_amount: number;
  first_month_amount: number | null;
  fee_amount: number;
  total_repayment: number;
  expires_at: string;
  sent_at: string;
  responded_at: string | null;
  decline_reason: string | null;
  status: string;
  lender_ref_no: string | null;
  disbursed_at: string | null;
}

export interface ApplicationView {
  id: string;
  ref_no: string;
  amount_requested: number;
  months: number;
  product_label: string | null;
  status: string;
  created_at: string;
  score: number | null;
  profile: ProfileSnapshot;
  offers: OfferView[];
  hasMandate: boolean;
}

export interface MonitorRow {
  borrower: string;
  employer: string;
  lender_ref_no: string | null;
  principal: number | null;
  monthly_amount: number;
  paid: number;
  total: number;
  is_overdue: boolean;
  period_status: string;
}

function dt(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ApplicationQueue({ items }: { items: ApplicationView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="mt-3 text-sm text-neutral-500">전달된 신청이 없습니다.</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      {items.map((a) => (
        <div key={a.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
          <button
            onClick={() => setOpenId(openId === a.id ? null : a.id)}
            className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left"
          >
            <div>
              <p className="text-sm font-medium">
                <span className="font-mono">{a.ref_no}</span>
                {/* A staff number, not a name. Before a loan exists the partner
                    is assessing a profile, not a person. */}
                <span className="ml-2 text-neutral-500">
                  {a.profile.employee_no ?? '—'} · {a.profile.employer ?? '—'}
                </span>
              </p>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {formatRupiah(a.amount_requested)} · 희망 {a.months}개월 ·{' '}
                {a.product_label ?? '일반'} · 신청 {a.created_at.slice(0, 10)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">
                {a.score ?? '—'}
                <span className="text-sm font-normal text-neutral-500"> / 850</span>
              </p>
              <p className="text-xs text-neutral-500">
                {a.score === null ? '점수 없음' : BAND_LABELS[band(a.score)]} ·{' '}
                {statusLabel(a)}
              </p>
            </div>
          </button>
          {openId === a.id && <ApplicationDetail item={a} />}
        </div>
      ))}
    </div>
  );
}

function statusLabel(a: ApplicationView): string {
  const live = a.offers.find((o) => o.status === 'sent' || o.status === 'accepted');
  if (live) return OFFER_STATUS_LABELS[live.status] ?? live.status;
  const last = a.offers[0];
  if (a.status === 'rejected') return '거절함';
  if (a.status === 'disbursed' || last?.status === 'disbursed') return '실행 완료';
  if (last) return OFFER_STATUS_LABELS[last.status] ?? last.status;
  return '심사 대기';
}

function ApplicationDetail({ item }: { item: ApplicationView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [rate, setRate] = useState(18);
  const [months, setMonths] = useState(item.months || 10);
  const [fee, setFee] = useState(1.5);
  const [method, setMethod] = useState<RepaymentMethod>('annuity');
  const [validDays, setValidDays] = useState(3);
  const [reason, setReason] = useState('');
  const [refNo, setRefNo] = useState('');

  const terms = {
    principal: item.amount_requested,
    annualRate: rate,
    months,
    feePercent: fee,
    method,
  };
  const problems = validateOffer(terms);
  const schedule = problems.length === 0 ? buildSchedule(terms) : null;

  const live = item.offers.find((o) => o.status === 'sent' || o.status === 'accepted');
  const disbursed = item.offers.find((o) => o.status === 'disbursed');
  const canOffer = item.status === 'referred' && !live && !disbursed;

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
    else setNote(ok);
    router.refresh();
  }

  return (
    <div className="border-t border-neutral-200 p-4 dark:border-neutral-800">
      {/* --- 신용 프로필 -------------------------------------------------- */}
      <h3 className="text-base font-semibold">신청자 신용 프로필 (GajiOne 제공)</h3>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="신용점수" value={item.score === null ? '—' : `${item.score} / 850`} />
        <Fact
          label="근속"
          value={item.profile.tenure_years == null ? '제공 범위 밖' : `${item.profile.tenure_years}년`}
        />
        <Fact label="출근" value={item.profile.attendance ?? '제공 범위 밖'} />
        <Fact label="상환이력" value={item.profile.repayment ?? '제공 범위 밖'} />
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        이 프로필은 GajiOne이 급여·근태 데이터로 산출해 제공합니다. 직원의 신원·급여 원본은
        공유되지 않으며, 표시 범위는 직원이 동의한 범위(
        {item.profile.scope === 'score_only'
          ? '신용점수만'
          : item.profile.scope === 'full_payroll'
            ? '급여 전체'
            : '신용점수·근속'}
        )를 따릅니다.
      </p>

      {/* --- 오퍼 이력 ---------------------------------------------------- */}
      {item.offers.length > 0 && (
        <div className="mt-5">
          <h3 className="text-base font-semibold">오퍼 진행</h3>
          {live || disbursed ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {offerStages((live ?? disbursed)!.status, item.hasMandate).map((s) => (
                <span
                  key={s.no}
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    s.state === 'done'
                      ? 'border-neutral-300 text-neutral-500 dark:border-neutral-700'
                      : s.state === 'active'
                        ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300'
                        : 'border-neutral-200 text-neutral-400 dark:border-neutral-800'
                  }`}
                >
                  {s.state === 'done' ? '✓ ' : `${s.no}. `}
                  {s.label}
                </span>
              ))}
            </div>
          ) : null}
          <ul className="mt-3 space-y-2 text-sm">
            {item.offers.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <span>
                  연 {o.annual_rate}% · {o.months}개월 · 수수료 {o.fee_percent}% ·{' '}
                  {REPAYMENT_LABELS[o.repayment_method as RepaymentMethod] ?? o.repayment_method}
                  <span className="ml-2 text-neutral-500">
                    월 {formatRupiah(o.monthly_amount)}
                  </span>
                </span>
                <span className="text-neutral-500">
                  {OFFER_STATUS_LABELS[o.status] ?? o.status} · 발송 {dt(o.sent_at)}
                  {o.status === 'sent' && ` · 만료 ${dt(o.expires_at)}`}
                  {o.lender_ref_no && ` · ${o.lender_ref_no}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- 오퍼 작성 ---------------------------------------------------- */}
      {canOffer && (
        <div className="mt-5">
          <h3 className="text-base font-semibold">오퍼 작성</h3>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <label className="block">
              <span className="text-xs text-neutral-500">연 이자율 (%)</span>
              <input
                type="number"
                step={0.5}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">상환기간 (개월)</span>
              <input
                type="number"
                value={months}
                onChange={(e) => setMonths(Number(e.target.value))}
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">수수료 (%)</span>
              <input
                type="number"
                step={0.1}
                value={fee}
                onChange={(e) => setFee(Number(e.target.value))}
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">상환방식</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as RepaymentMethod)}
                className={field}
              >
                <option value="annuity">원리금균등</option>
                <option value="equal_principal">원금균등</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">유효기간 (일)</span>
              <input
                type="number"
                value={validDays}
                onChange={(e) => setValidDays(Number(e.target.value))}
                className={field}
              />
            </label>
          </div>

          {schedule ? (
            <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  {method === 'equal_principal' ? '1회차 상환액' : '월 상환액'}{' '}
                  <strong className="tabular-nums">{formatRupiah(schedule.firstMonthAmount)}</strong>
                </span>
                <span>
                  최초 1회 수수료{' '}
                  <strong className="tabular-nums">{formatRupiah(schedule.feeAmount)}</strong>
                </span>
                <span>
                  총 상환{' '}
                  <strong className="tabular-nums">{formatRupiah(schedule.totalRepayment)}</strong>
                </span>
                <span className="text-neutral-500">
                  이자 {formatRupiah(schedule.totalInterest)}
                </span>
              </div>
              {method === 'equal_principal' && (
                /* Under equal principal the first instalment is the largest,
                   and it is the one the deduction ceiling has to clear. */
                <p className="mt-1 text-xs text-neutral-500">
                  원금균등은 회차가 갈수록 줄어듭니다. 마지막 회차{' '}
                  {formatRupiah(schedule.instalments.at(-1)!.total)} · 공제 여력은 1회차 기준으로
                  확인됩니다.
                </p>
              )}
            </div>
          ) : (
            <ul className="mt-3 space-y-1 text-sm text-red-600">
              {problems.map((p) => (
                <li key={p.field}>· {p.reason}</li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <button
              disabled={busy || problems.length > 0}
              onClick={() =>
                run(
                  () =>
                    sendOfferAction({
                      referralId: item.id,
                      annualRate: rate,
                      months,
                      feePercent: fee,
                      method,
                      validDays,
                    }),
                  '오퍼를 발송했습니다.'
                )
              }
              className={primary}
            >
              오퍼 발송
            </button>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="거절 사유"
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              disabled={busy || !reason.trim()}
              onClick={() => run(() => declineReferralAction(item.id, reason), '거절로 기록했습니다.')}
              className={secondary}
            >
              신청 거절
            </button>
          </div>
        </div>
      )}

      {/* --- 발송 후 --------------------------------------------------- */}
      {live?.status === 'sent' && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="철회 사유"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            disabled={busy}
            onClick={() => run(() => withdrawOfferAction(live.id, reason), '오퍼를 철회했습니다.')}
            className={secondary}
          >
            오퍼 철회
          </button>
        </div>
      )}

      {live?.status === 'accepted' && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <input
            value={refNo}
            onChange={(e) => setRefNo(e.target.value)}
            placeholder="금융기관 참조번호 (필수)"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            disabled={busy || !refNo.trim()}
            onClick={() =>
              run(() => recordDisbursementAction(live.id, refNo), '실행으로 기록했습니다.')
            }
            className={primary}
          >
            대출 실행 기록
          </button>
        </div>
      )}

      {note && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{note}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm">{value}</p>
    </div>
  );
}

export function MonitorTable({ rows }: { rows: MonitorRow[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-neutral-500">실행된 대출이 없습니다.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
          <tr>
            <th className="px-3 py-2 font-medium">차입자</th>
            <th className="px-3 py-2 font-medium">고용주</th>
            <th className="px-3 py-2 text-right font-medium">원금</th>
            <th className="px-3 py-2 text-right font-medium">월 상환액</th>
            <th className="px-3 py-2 font-medium">진행</th>
            <th className="px-3 py-2 font-medium">GajiOne 공제 대사</th>
            <th className="px-3 py-2 font-medium">연체</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="px-3 py-2">
                {r.borrower}
                {r.lender_ref_no && (
                  <span className="ml-2 font-mono text-xs text-neutral-500">{r.lender_ref_no}</span>
                )}
              </td>
              <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{r.employer}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.principal === null ? '—' : formatRupiah(r.principal)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(r.monthly_amount)}</td>
              <td className="px-3 py-2 tabular-nums">
                {r.paid} / {r.total} 회차
              </td>
              <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                {r.period_status}
              </td>
              <td className="px-3 py-2">
                <span className={r.is_overdue ? 'text-red-600' : ''}>
                  {r.is_overdue ? '연체' : '정상'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
