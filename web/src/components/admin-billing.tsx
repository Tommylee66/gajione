'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updatePlanPricingAction,
  generateInvoicesAction,
  issueInvoicesAction,
} from '@/app/admin/actions';
import { formatRupiah } from '@/lib/format';
import {
  applyTiers,
  buildInvoice,
  validatePricing,
  INVOICE_STATUS_LABELS,
  type VolumeTier,
} from '@/lib/billing/invoice';

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  base_fee: number;
  per_employee_fee: number;
  whitelabel_fee: number;
  whitelabel_monthly_fee: number;
  annual_prepay_discount: number;
  volume_tiers: VolumeTier[];
}

export interface InvoiceRow {
  id: string;
  period: string;
  company: string;
  plan_code: string | null;
  employee_count: number;
  base_amount: number;
  per_employee_amount: number;
  whitelabel_amount: number;
  discount_amount: number;
  total_amount: number;
  status: string;
  breakdown: Record<string, unknown>;
}

const field =
  'mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-right dark:border-neutral-700 dark:bg-neutral-950';

export function BillingPanel({
  plans,
  invoices,
  periods,
}: {
  plans: PlanRow[];
  invoices: InvoiceRow[];
  periods: string[];
}) {
  const router = useRouter();
  const now = new Date();
  const [period, setPeriod] = useState(
    periods[0] ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; generated?: number; total?: number }>) {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
    else
      setNote(
        r.total !== undefined
          ? `${r.generated}건 · 합계 ${formatRupiah(r.total)}`
          : `${r.generated}건 처리했습니다.`
      );
    router.refresh();
  }

  const shown = invoices.filter((i) => i.period === period);
  const drafts = shown.filter((i) => i.status === 'draft').length;

  return (
    <>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">요금제 설정</h2>
        <p className="mt-1 text-sm text-neutral-500">
          볼륨 구간은 한계 적용입니다. 기준 인원을 넘는 인원분에만 해당 할인율이 적용되며, 인원이
          늘 때 총액이 줄어드는 구간은 생기지 않습니다.
        </p>
        <div className="mt-3 space-y-4">
          {plans.map((p) => (
            <PlanEditor key={p.id} plan={p} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">월 청구</h2>
            <p className="mt-1 text-sm text-neutral-500">
              현재 요금제 설정으로 계산합니다. 초안으로 만들어지고, 검토 후 발행합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-xs text-neutral-500">청구월</span>
              <input
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="2026-09"
                className="mt-1 block w-28 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <button
              disabled={busy}
              onClick={() => run(() => generateInvoicesAction(period))}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
            >
              빌링 생성
            </button>
            <button
              disabled={busy || drafts === 0}
              onClick={() => run(() => issueInvoicesAction(period))}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              발행 ({drafts})
            </button>
          </div>
        </div>

        {note && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{note}</p>}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {shown.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">고객사</th>
                  <th className="px-3 py-2 font-medium">요금제</th>
                  <th className="px-3 py-2 text-right font-medium">직원수</th>
                  <th className="px-3 py-2 text-right font-medium">기본</th>
                  <th className="px-3 py-2 text-right font-medium">인원</th>
                  <th className="px-3 py-2 text-right font-medium">화이트라벨</th>
                  <th className="px-3 py-2 text-right font-medium">할인</th>
                  <th className="px-3 py-2 text-right font-medium">합계</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">
                      {i.company}
                      {/* Where the headcount came from. The two sources can
                          differ and the difference is the first thing queried. */}
                      {i.breakdown.headcount_source === 'live_employees' && (
                        <span className="ml-2 text-xs text-amber-600">현재 인원 기준</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{i.plan_code ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.employee_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(i.base_amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatRupiah(i.per_employee_amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {i.whitelabel_amount > 0 ? formatRupiah(i.whitelabel_amount) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {i.discount_amount > 0 ? `−${formatRupiah(i.discount_amount)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatRupiah(i.total_amount)}
                    </td>
                    <td className="px-3 py-2">{INVOICE_STATUS_LABELS[i.status] ?? i.status}</td>
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

function PlanEditor({ plan }: { plan: PlanRow }) {
  const router = useRouter();
  const [base, setBase] = useState(plan.base_fee);
  const [per, setPer] = useState(plan.per_employee_fee);
  const [wlSetup, setWlSetup] = useState(plan.whitelabel_fee);
  const [wlMonthly, setWlMonthly] = useState(plan.whitelabel_monthly_fee);
  const [prepay, setPrepay] = useState(plan.annual_prepay_discount);
  const [tiers, setTiers] = useState<VolumeTier[]>(plan.volume_tiers);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draft = {
    code: plan.code,
    name: plan.name,
    base_fee: base,
    per_employee_fee: per,
    whitelabel_fee: wlSetup,
    whitelabel_monthly_fee: wlMonthly,
    annual_prepay_discount: prepay,
    volume_tiers: tiers,
  };
  const problems = validatePricing(draft);

  // A worked example, so a pricing change is visible as money before it is
  // saved rather than after an invoice run.
  const sample = problems.length === 0 ? buildInvoice({
    plan: draft,
    employeeCount: 412,
    whitelabel: false,
    whitelabelSetupDue: false,
    annualPrepay: false,
    contractDiscountPercent: 0,
  }) : null;

  async function save() {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await updatePlanPricingAction({
      planId: plan.id,
      baseFee: base,
      perEmployeeFee: per,
      whitelabelFee: wlSetup,
      whitelabelMonthlyFee: wlMonthly,
      annualPrepayDiscount: prepay,
      volumeTiers: tiers,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '저장에 실패했습니다.');
    setNote('저장했습니다.');
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="text-base font-semibold">{plan.name}</h3>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Num label="정액 기본요금" value={base} onChange={setBase} />
        <Num label="인당 월 요금" value={per} onChange={setPer} />
        <Num label="화이트라벨 설정비 (1회)" value={wlSetup} onChange={setWlSetup} />
        <Num label="화이트라벨 월 유지비" value={wlMonthly} onChange={setWlMonthly} />
        <Num label="연간 선결제 할인 (%)" value={prepay} onChange={setPrepay} step={0.5} />
      </div>

      <div className="mt-3">
        <p className="text-xs text-neutral-500">볼륨 할인 구간</p>
        <div className="mt-1 space-y-2">
          {tiers.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <input
                type="number"
                value={t.over}
                onChange={(e) =>
                  setTiers(tiers.map((x, j) => (j === i ? { ...x, over: Number(e.target.value) } : x)))
                }
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-right text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-neutral-500">명 초과분</span>
              <input
                type="number"
                step={0.5}
                value={t.discount_percent}
                onChange={(e) =>
                  setTiers(
                    tiers.map((x, j) =>
                      j === i ? { ...x, discount_percent: Number(e.target.value) } : x
                    )
                  )
                }
                className="w-20 rounded-md border border-neutral-300 px-2 py-1.5 text-right text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-neutral-500">% 할인</span>
              <button
                onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                className="text-sm text-neutral-500 underline"
              >
                삭제
              </button>
            </div>
          ))}
          <button
            onClick={() => setTiers([...tiers, { over: 0, discount_percent: 0 }])}
            className="text-sm text-blue-600 underline"
          >
            + 구간 추가
          </button>
        </div>
      </div>

      {sample && (
        <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
          <p className="text-xs text-neutral-500">412명 기준 예시</p>
          <p className="mt-1 tabular-nums">
            기본 {formatRupiah(sample.baseAmount)} + 인원 {formatRupiah(sample.perEmployeeAmount)} ={' '}
            <strong>{formatRupiah(sample.totalAmount)}</strong>
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            {applyTiers(412, per, tiers)
              .map((t) => `${t.from}–${t.to ?? ''} ${t.heads}명 × ${t.rate.toLocaleString('id-ID')}`)
              .join(' · ')}
          </p>
        </div>
      )}

      {problems.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-red-600">
          {problems.map((p, i) => (
            <li key={i}>· {p.reason}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          disabled={busy || problems.length > 0}
          onClick={save}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          저장
        </button>
        {note && <span className="text-sm text-neutral-500">{note}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-500">{label}</span>
      <input
        type="number"
        step={step ?? 1000}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={field}
      />
    </label>
  );
}
