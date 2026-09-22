'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { respondToMyOfferAction } from '@/app/me/actions';
import { formatRupiah } from '@/lib/format';

/**
 * The worker's own answer to a loan offer.
 *
 * Every figure they are agreeing to is on the card before the button: the
 * monthly deduction, the fee, the total. An acceptance given without the total
 * in front of somebody is a signature on a number they never saw.
 */
export function MyOffer({
  offer,
  available,
}: {
  offer: {
    id: string;
    annual_rate: number;
    months: number;
    fee_percent: number;
    fee_amount: number;
    method_label: string;
    monthly_amount: number;
    total_repayment: number;
    expires_at: string;
    expired: boolean;
  };
  available: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function respond(response: 'accepted' | 'declined') {
    setBusy(true);
    setError(null);
    const r = await respondToMyOfferAction(offer.id, response, reason);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '처리에 실패했습니다.');
    setConfirming(false);
    router.refresh();
  }

  const overCap = offer.monthly_amount > available;

  return (
    <section className="mt-4 rounded-lg border border-violet-300 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950">
      <p className="text-sm font-semibold">대출 오퍼가 도착했습니다</p>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="월 상환액" value={formatRupiah(offer.monthly_amount)} strong />
        <Row label="상환 기간" value={`${offer.months}개월 · ${offer.method_label}`} />
        <Row label="연 이자율" value={`${offer.annual_rate}%`} />
        <Row label="최초 1회 수수료" value={`${formatRupiah(offer.fee_amount)} (${offer.fee_percent}%)`} />
        <Row label="총 상환액" value={formatRupiah(offer.total_repayment)} strong />
      </dl>
      <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
        수락하면 매월 급여에서 {formatRupiah(offer.monthly_amount)}이 공제됩니다. 유효기간{' '}
        {new Date(offer.expires_at).toLocaleString('ko-KR')}
        {offer.expired && ' · 만료됨'}
      </p>
      {overCap && (
        <p className="mt-2 text-sm text-red-600">
          월 상환액이 현재 공제 여력 {formatRupiah(available)}을 넘습니다. 수락할 수 없습니다.
        </p>
      )}

      {!offer.expired && !overCap && (
        <div className="mt-3">
          {confirming ? (
            <div className="rounded-md border border-violet-400 bg-white p-3 dark:bg-neutral-950">
              {/* A second step, because this one takes money out of every
                  payslip for the next several months. */}
              <p className="text-sm">
                매월 {formatRupiah(offer.monthly_amount)}씩 {offer.months}개월간 급여에서
                공제하는 데 동의하십니까?
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => respond('accepted')}
                  className="rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  동의하고 수락
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <button
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                수락
              </button>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="거절 사유 (선택)"
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <button
                disabled={busy}
                onClick={() => respond('declined')}
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
              >
                거절
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}
