'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateCustomerAction } from '@/app/admin/actions';
import { formatRupiah } from '@/lib/format';
import { COMPANY_STATUS_LABELS } from '@/lib/billing/invoice';

export interface CustomerRow {
  id: string;
  name: string;
  industry: string | null;
  status: string;
  joined_at: string;
  headcount: number;
  plan: string | null;
  monthly: number | null;
  cs_owner: string | null;
  contract_started_on: string | null;
  contract_renews_on: string | null;
  churn_reason: string | null;
  lending_enabled: boolean;
}

const FILTERS = ['all', 'active', 'trial', 'churning'] as const;

export function CustomerTable({ rows }: { rows: CustomerRow[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              f === filter
                ? 'border-blue-600 text-blue-600'
                : 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            {f === 'all' ? '전체' : COMPANY_STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">해당하는 고객사가 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">회사명</th>
                <th className="px-3 py-2 font-medium">업종</th>
                <th className="px-3 py-2 text-right font-medium">직원수</th>
                <th className="px-3 py-2 font-medium">요금제</th>
                <th className="px-3 py-2 text-right font-medium">월 청구액</th>
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 font-medium">가입일</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <>
                  <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {r.industry ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.headcount}명</td>
                    <td className="px-3 py-2">{r.plan ?? '구독 없음'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.monthly === null ? '—' : formatRupiah(r.monthly)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={r.status === 'churning' ? 'text-red-600' : ''}>
                        {COMPANY_STATUS_LABELS[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{r.joined_at}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setOpenId(openId === r.id ? null : r.id)}
                        className="text-sm text-blue-600 underline"
                      >
                        {openId === r.id ? '닫기' : '계약 정보'}
                      </button>
                    </td>
                  </tr>
                  {openId === r.id && (
                    <tr key={`${r.id}-detail`}>
                      <td colSpan={8} className="border-t border-neutral-200 p-0 dark:border-neutral-800">
                        <CustomerForm row={r} onDone={() => setOpenId(null)} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CustomerForm({ row, onDone }: { row: CustomerRow; onDone: () => void }) {
  const router = useRouter();
  const [status, setStatus] = useState(row.status);
  const [owner, setOwner] = useState(row.cs_owner ?? '');
  const [started, setStarted] = useState(row.contract_started_on ?? '');
  const [renews, setRenews] = useState(row.contract_renews_on ?? '');
  const [reason, setReason] = useState(row.churn_reason ?? '');
  const [lending, setLending] = useState(row.lending_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field =
    'mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';

  async function save() {
    setBusy(true);
    setError(null);
    const r = await updateCustomerAction({
      companyId: row.id,
      status,
      csOwner: owner,
      contractStartedOn: started,
      contractRenewsOn: renews,
      churnReason: reason,
      lendingEnabled: lending,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '저장에 실패했습니다.');
    onDone();
    router.refresh();
  }

  return (
    <div className="bg-neutral-50 p-4 dark:bg-neutral-900">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="text-xs text-neutral-500">상태</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
            {Object.entries(COMPANY_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">담당 CS</span>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">계약 시작일</span>
          <input type="date" value={started} onChange={(e) => setStarted(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">갱신일</span>
          <input type="date" value={renews} onChange={(e) => setRenews(e.target.value)} className={field} />
        </label>
      </div>

      {status === 'churning' && (
        <label className="mt-3 block">
          <span className="text-xs text-neutral-500">해지 사유 (필수)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="내부 시스템 전환"
            className={field}
          />
        </label>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={lending} onChange={(e) => setLending(e.target.checked)} />
        {/* Off by default and switched on deliberately: it sends employee
            profiles to a third party. */}
        대출 연동 사용 — 직원 신용 프로필이 제휴 금융기관에 전달됩니다
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button
          disabled={busy}
          onClick={save}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          저장
        </button>
        <button onClick={onDone} className="text-sm text-neutral-500 underline">
          취소
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
