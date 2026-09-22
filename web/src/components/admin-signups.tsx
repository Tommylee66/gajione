'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveSignupAction, rejectSignupAction } from '@/app/admin/actions';

export interface SignupRow {
  id: string;
  company_name: string;
  npwp: string | null;
  industry: string | null;
  headcount_band: string | null;
  region: string | null;
  contact_name: string;
  contact_title: string | null;
  email: string;
  phone: string | null;
  marketing_opt_in: boolean;
  status: string;
  reject_reason: string | null;
  created_at: string;
}

const field =
  'mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export function SignupQueue({
  rows,
  plans,
  regions,
}: {
  rows: SignupRow[];
  plans: { id: string; name: string }[];
  regions: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const pending = rows.filter((r) => r.status === 'pending');
  const handled = rows.filter((r) => r.status !== 'pending');

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">가입 신청</h2>
      <p className="mt-1 text-sm text-neutral-500">
        대기 {pending.length}건. 승인하면 고객사와 구독이 함께 만들어지고 계정이 활성화됩니다.
      </p>

      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">대기 중인 신청이 없습니다.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {pending.map((r) => (
            <div key={r.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
              <button
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left"
              >
                <div>
                  <p className="text-sm font-medium">{r.company_name}</p>
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {r.contact_name}
                    {r.contact_title && ` (${r.contact_title})`} · {r.email}
                    {r.phone && ` · ${r.phone}`}
                  </p>
                </div>
                <div className="text-right text-sm text-neutral-500">
                  {r.industry ?? '업종 미기재'} · {r.headcount_band ?? '규모 미기재'}
                  <br />
                  신청 {r.created_at.slice(0, 10)}
                </div>
              </button>
              {openId === r.id && (
                <ReviewForm row={r} plans={plans} regions={regions} onDone={() => setOpenId(null)} />
              )}
            </div>
          ))}
        </div>
      )}

      {handled.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-neutral-500">
            처리 완료 {handled.length}건
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {handled.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {r.company_name} · {r.email}
                </span>
                <span className={r.status === 'rejected' ? 'text-red-600' : 'text-neutral-500'}>
                  {r.status === 'approved' ? '승인' : `거절 — ${r.reject_reason ?? ''}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ReviewForm({
  row,
  plans,
  regions,
  onDone,
}: {
  row: SignupRow;
  plans: { id: string; name: string }[];
  regions: string[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [region, setRegion] = useState(regions[0] ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '처리에 실패했습니다.');
    onDone();
    router.refresh();
  }

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Fact label="NPWP" value={row.npwp ?? '—'} />
        <Fact label="소재지" value={row.region ?? '—'} />
        <Fact label="예상 규모" value={row.headcount_band ?? '—'} />
        <Fact label="마케팅 수신" value={row.marketing_opt_in ? '동의' : '미동의'} />
      </dl>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs text-neutral-500">요금제</span>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={field}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-neutral-500">UMK 지역</span>
          {/* Required, because without it the minimum-wage gate has nothing to
              compare against and would pass everyone while testing nothing. */}
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={field}>
            {regions.length === 0 && <option value="">등록된 UMK 지역 없음</option>}
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <button
          disabled={busy || !planId || !region}
          onClick={() => run(() => approveSignupAction({ requestId: row.id, planId, umkRegion: region }))}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          승인
        </button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="거절 사유"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button
          disabled={busy || !reason.trim()}
          onClick={() => run(() => rejectSignupAction(row.id, reason))}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
        >
          거절
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
