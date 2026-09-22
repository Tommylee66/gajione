'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  uploadTaxTableAction,
  upsertUmkAction,
  updatePolicyAction,
  type Result,
} from '@/app/policy/actions';
import { TAX_TABLE_TEMPLATE } from '@/lib/rates/tax-table-csv';
import { formatRupiah } from '@/lib/format';

export interface BpjsRow {
  program: string;
  employee_rate: number;
  employer_rate: number;
  wage_cap: number | null;
  risk_class: string | null;
  version: string;
}

export interface UmkRow {
  region: string;
  amount: number;
  year: number;
}

export interface TaxVersion {
  version: string;
  effective_from: string;
  effective_to: string | null;
  bands: number;
  categories: string[];
}

interface Props {
  bpjs: BpjsRow[];
  umk: UmkRow[];
  taxVersions: TaxVersion[];
  policy: {
    varianceThreshold: number;
    maxLoanDeductionRate: number;
    weeklyOtCapHours: number;
  };
  isOperator: boolean;
  canEditPolicy: boolean;
}

const PROGRAM_LABELS: Record<string, string> = {
  kesehatan: 'Kesehatan (건강보험)',
  jht: 'JHT (노후보장)',
  jp: 'JP (연금)',
  jkk: 'JKK (산재)',
  jkm: 'JKM (사망)',
};

export function PolicyPanel({
  bpjs,
  umk,
  taxVersions,
  policy,
  isOperator,
  canEditPolicy,
}: Props) {
  return (
    <div className="mt-8 space-y-12">
      <TaxSection versions={taxVersions} isOperator={isOperator} />
      <BpjsSection rows={bpjs} />
      <UmkSection rows={umk} isOperator={isOperator} />
      <GateSection policy={policy} canEdit={canEditPolicy} />
    </div>
  );
}

function TaxSection({ versions, isOperator }: { versions: TaxVersion[]; isOperator: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get('file') as File | null;
    if (!file || file.size === 0) return;
    setBusy(true);
    setResult(null);
    setResult(
      await uploadTaxTableAction({
        csvText: await file.text(),
        version: String(fd.get('version') ?? ''),
        effectiveFrom: String(fd.get('effective_from') ?? ''),
      })
    );
    setBusy(false);
    router.refresh();
  }

  function downloadTemplate() {
    const blob = new Blob([TAX_TABLE_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ter-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const active = versions.find((v) => v.effective_to === null);

  return (
    <section>
      <h2 className="text-lg font-semibold">PPh 21 세율표</h2>
      <p className="mt-1 text-sm text-neutral-500">
        TER(월 원천징수 유효세율) 방식. 새 고시가 나오면 교체가 아니라 새 버전으로 올립니다 —
        과거 차수가 자기가 쓴 버전을 기록하고 있어 명세서를 그대로 재현할 수 있어야 합니다.
      </p>

      {versions.length === 0 ? (
        <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950">
          <p className="font-medium text-red-800 dark:text-red-200">
            등록된 세율표가 없습니다. 급여 계산(G2)이 진행되지 않습니다.
          </p>
          <p className="mt-1 text-red-700 dark:text-red-300">
            PMK 168/2023 고시표를 CSV로 올려 주세요.
          </p>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">버전</th>
                <th className="px-3 py-2 font-medium">적용 시작</th>
                <th className="px-3 py-2 font-medium">적용 종료</th>
                <th className="px-3 py-2 font-medium">구분</th>
                <th className="px-3 py-2 text-right font-medium">구간</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2 font-medium">
                    {v.version}
                    {v.effective_to === null && (
                      <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                        적용 중
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{v.effective_from}</td>
                  <td className="px-3 py-2 tabular-nums">{v.effective_to ?? '—'}</td>
                  <td className="px-3 py-2">{v.categories.join(' · ')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.bands}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isOperator && (
        <form
          onSubmit={onSubmit}
          className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <h3 className="text-sm font-semibold">새 버전 업로드</h3>
          <p className="mt-1 text-xs text-neutral-500">
            컬럼: <code>category, lower_bound, upper_bound, rate</code> · 세율은 비율(5% → 0.05)
            · 최고 구간은 상한을 비워 둡니다
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs font-medium text-neutral-500">버전 이름</span>
              <input
                name="version"
                required
                placeholder="TER-2026.1"
                defaultValue={active ? '' : 'TER-2026.1'}
                className={input}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-neutral-500">적용 시작일</span>
              <input type="date" name="effective_from" required className={input} />
            </label>
            <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
            <button
              disabled={busy}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? '검증 중…' : '업로드'}
            </button>
            <button
              type="button"
              onClick={downloadTemplate}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              템플릿 받기
            </button>
          </div>

          {result && !result.ok && (
            <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
              <p className="font-medium text-red-800 dark:text-red-200">{result.error}</p>
              {result.parseErrors && (
                <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
                  {result.parseErrors.map((e, i) => (
                    <li key={i}>
                      {e.lineNo > 0 && <span className="font-mono">{e.lineNo}행 — </span>}
                      {e.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result?.ok && (
            <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
              구간 {result.bands}개 저장 · 구분 {result.categories?.join(' · ')}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function BpjsSection({ rows }: { rows: BpjsRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">BPJS 요율</h2>
      <p className="mt-1 text-sm text-neutral-500">
        법정 요율입니다. 상한이 적용되는 항목은 그 금액까지만 부과됩니다.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">항목</th>
              <th className="px-3 py-2 text-right font-medium">직원 부담</th>
              <th className="px-3 py-2 text-right font-medium">회사 부담</th>
              <th className="px-3 py-2 font-medium">상한</th>
              <th className="px-3 py-2 font-medium">비고</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.program} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">{PROGRAM_LABELS[r.program] ?? r.program}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.employee_rate > 0 ? `${(r.employee_rate * 100).toFixed(2)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.employer_rate > 0 ? `${(r.employer_rate * 100).toFixed(2)}%` : '—'}
                </td>
                <td className="px-3 py-2">
                  {r.wage_cap ? formatRupiah(r.wage_cap) : '미적용'}
                </td>
                <td className="px-3 py-2 text-neutral-500">
                  {r.risk_class ? `${r.risk_class} 요율` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        JKM(사망보장)은 아직 등록되지 않았습니다. 목업 정책 화면에 없어 임의로 채우지 않았으며,
        실제 운영 전에 확인이 필요합니다.
      </p>
    </section>
  );
}

function UmkSection({ rows, isOperator }: { rows: UmkRow[]; isOperator: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    const r = await upsertUmkAction({
      region: String(fd.get('region') ?? ''),
      amount: Number(fd.get('amount') ?? 0),
      year: Number(fd.get('year') ?? new Date().getFullYear()),
    });
    if (!r.ok) return setError(r.error ?? '저장에 실패했습니다.');
    form.reset();
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-lg font-semibold">지역별 최저임금 (UMK)</h2>
      <p className="mt-1 text-sm text-neutral-500">
        매년 지역별로 개정됩니다. 직원의 UMK 지역에 해당 연도 금액이 없으면 G2의 최저임금 검사가
        통과하지 못합니다 — 0으로 채워 넣는 것보다 막히는 편이 안전하기 때문입니다.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">지역</th>
              <th className="px-3 py-2 text-right font-medium">금액</th>
              <th className="px-3 py-2 text-right font-medium">연도</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-neutral-500">
                  등록된 지역이 없습니다.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={`${r.region}|${r.year}`}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td className="px-3 py-2">{r.region}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(r.amount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.year}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isOperator && (
        <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">지역</span>
            <input name="region" required placeholder="Karawang" className={input} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">금액 (Rp)</span>
            <input
              type="number"
              name="amount"
              required
              min={1}
              step={1000}
              className={`${input} w-40 text-right`}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">연도</span>
            <input
              type="number"
              name="year"
              required
              defaultValue={2026}
              className={`${input} w-24`}
            />
          </label>
          <button className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
            저장
          </button>
          {error && <p className="w-full text-sm text-red-600">{error}</p>}
        </form>
      )}
    </section>
  );
}

function GateSection({
  policy,
  canEdit,
}: {
  policy: Props['policy'];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    const r = await updatePolicyAction({
      varianceThreshold: Number(fd.get('variance') ?? 20),
      maxLoanDeductionRate: Number(fd.get('loan_cap') ?? 30),
      weeklyOtCapHours: Number(fd.get('ot_cap') ?? 18),
    });
    if (!r.ok) return setError(r.error ?? '저장에 실패했습니다.');
    setSaved(true);
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-lg font-semibold">품질게이트 임계값</h2>
      <p className="mt-1 text-sm text-neutral-500">
        법정 요율과 달리 이쪽은 회사 정책입니다. 다만 OT 주간 상한은 UU 13/2003의 18시간이
        기준이라, 늘리려면 근거가 필요합니다.
      </p>

      <form
        onSubmit={onSubmit}
        className="mt-3 flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">급여 변동 소명 임계치 (%)</span>
          <input
            type="number"
            name="variance"
            min={1}
            max={100}
            step={1}
            defaultValue={policy.varianceThreshold}
            disabled={!canEdit}
            className={`${input} w-28 text-right`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">대출 공제 상한 (%)</span>
          <input
            type="number"
            name="loan_cap"
            min={0}
            max={100}
            step={1}
            defaultValue={policy.maxLoanDeductionRate}
            disabled={!canEdit}
            className={`${input} w-28 text-right`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-neutral-500">OT 주간 상한 (시간)</span>
          <input
            type="number"
            name="ot_cap"
            min={1}
            max={40}
            step={1}
            defaultValue={policy.weeklyOtCapHours}
            disabled={!canEdit}
            className={`${input} w-28 text-right`}
          />
        </label>
        {canEdit && (
          <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            저장
          </button>
        )}
        {saved && <span className="text-sm text-neutral-500">저장했습니다.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </form>
    </section>
  );
}

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950';
