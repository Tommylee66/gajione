'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateOtPolicyAction,
  updatePositionOtAction,
  updateProrationAction,
  savePayComponentAction,
  updatePayrollTypeAction,
  type PayComponentInput,
} from '@/app/policy/actions';
import { formatRupiah } from '@/lib/format';

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950';
const primary =
  'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';

export interface OtRuleRow {
  day_type: string;
  from_hour: number;
  to_hour: number | null;
  multiplier: number;
  multiplier_max: number | null;
  legal_basis: string | null;
}

export interface PositionRow {
  id: string;
  name: string;
  grade_level: number | null;
  ot_eligible: boolean;
}

export interface DepartmentRow {
  id: string;
  name: string;
  proration_basis: string | null;
}

export interface PayComponentRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  calc_type: string;
  amount: number | null;
  formula: string | null;
  taxable: boolean;
  bpjs_base: boolean;
  prorate: boolean;
  recurring: boolean;
  gross_up: boolean;
  borne_by: string;
  active: boolean;
}

export interface PayrollTypeRow {
  id: string;
  run_type: string;
  enabled: boolean;
  execution: string;
  frequency: string | null;
  schedule_rule: string | null;
  legal_basis: string | null;
}

export interface AuditRow {
  action: string;
  created_at: string;
  actor_name: string | null;
  details: Record<string, unknown> | null;
}

const PRORATION_LABELS: Record<string, string> = {
  calendar: '달력일 기준',
  fixed_30: '30일 고정',
  working_days: '근무일 기준',
};

const RUN_TYPE_LABELS: Record<string, string> = {
  regular: '정기급여',
  thr: 'THR (종교휴일수당)',
  bonus: '상여금',
  resignation: '퇴직정산',
  correction: '정정',
};

const DAY_TYPE_LABELS: Record<string, string> = {
  weekday: '평일',
  holiday: '휴일',
  national_holiday: '공휴일',
};

function useSaver() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await fn();
    setBusy(false);
    // A partial success carries a message in `error` — the pay-component edit
    // that was accepted but narrowed. Reporting it as a plain success would
    // hide that half the change was refused.
    if (!r.ok) setError(r.error ?? '저장에 실패했습니다.');
    else if (r.error) setNote(r.error);
    else setNote('저장했습니다.');
    router.refresh();
  }
  return { busy, note, error, save };
}

function Status({ note, error }: { note: string | null; error: string | null }) {
  if (error) return <p className="mt-2 text-sm text-red-600">{error}</p>;
  if (note) return <p className="mt-2 text-sm text-neutral-500">{note}</p>;
  return null;
}

/* --- 지급 유형 및 스케줄 ------------------------------------------------- */

export function PayrollTypeSection({
  rows,
  canEdit,
}: {
  rows: PayrollTypeRow[];
  canEdit: boolean;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">지급 유형 및 스케줄</h2>
      {/* The point of the card: these are separate batches, not line items on
          one payslip. Each passes its own gates and produces its own file. */}
      <p className="mt-1 text-sm text-neutral-500">
        정기급여·THR·상여금·퇴직정산은 서로 다른 지급 파일로 생성되며, 한 달에 2건 이상의 지급이
        발생할 수 있습니다. 각 유형은 필요한 게이트만 거쳐 독립적으로 진행됩니다.
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <PayrollTypeCard key={r.id} row={r} canEdit={canEdit} />
        ))}
      </div>
    </section>
  );
}

function PayrollTypeCard({ row, canEdit }: { row: PayrollTypeRow; canEdit: boolean }) {
  const { busy, note, error, save } = useSaver();
  const [enabled, setEnabled] = useState(row.enabled);
  const [execution, setExecution] = useState(row.execution);
  const [frequency, setFrequency] = useState(row.frequency ?? '');
  const [rule, setRule] = useState(row.schedule_rule ?? '');

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{RUN_TYPE_LABELS[row.run_type] ?? row.run_type}</p>
          {row.legal_basis && (
            <p className="mt-0.5 text-xs text-neutral-500">{row.legal_basis}</p>
          )}
        </div>
        {canEdit && row.run_type !== 'regular' && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            사용
          </label>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-neutral-500">실행 방식</span>
          <select
            value={execution}
            onChange={(e) => setExecution(e.target.value)}
            disabled={!canEdit}
            className={`${input} w-full`}
          >
            <option value="separate">별도 배치로 지급</option>
            <option value="merged">정기급여와 통합 지급</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">주기</span>
          <input
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            disabled={!canEdit}
            className={`${input} w-full`}
          />
        </label>
        <label className="block sm:col-span-1">
          <span className="text-xs text-neutral-500">스케줄 규칙</span>
          <input
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            disabled={!canEdit}
            className={`${input} w-full`}
          />
        </label>
      </div>

      {canEdit && (
        <button
          disabled={busy}
          onClick={() =>
            save(() =>
              updatePayrollTypeAction({
                id: row.id,
                enabled,
                execution: execution as 'separate' | 'merged',
                frequency,
                scheduleRule: rule,
              })
            )
          }
          className={`mt-3 ${primary}`}
        >
          저장
        </button>
      )}
      <Status note={note} error={error} />
    </div>
  );
}

/* --- 초과근무(OT) 배율 --------------------------------------------------- */

export function OtSection({
  rules,
  policy,
  canEdit,
}: {
  rules: OtRuleRow[];
  policy: { otMode: string; otHourDivisor: number; otFixedHourlyRate: number | null };
  canEdit: boolean;
}) {
  const { busy, note, error, save } = useSaver();
  const [mode, setMode] = useState(policy.otMode);
  const [divisor, setDivisor] = useState(policy.otHourDivisor);
  const [fixed, setFixed] = useState(policy.otFixedHourlyRate ?? 0);

  return (
    <section>
      <h2 className="text-lg font-semibold">초과근무(OT) 배율</h2>
      <p className="mt-1 text-sm text-neutral-500">
        모든 회사가 배율 방식을 쓰지는 않습니다. 시간당 고정 요율을 쓰는 회사는 아래에서 방식을
        바꾸세요.
      </p>

      <div className="mt-3 flex flex-wrap gap-4">
        {(['multiplier', 'fixed_hourly'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={mode === m}
              disabled={!canEdit}
              onChange={() => setMode(m)}
            />
            {m === 'multiplier' ? '법정 배율 적용' : '고정 요율 적용'}
          </label>
        ))}
      </div>

      {mode === 'multiplier' && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">구간</th>
                <th className="px-3 py-2 text-right font-medium">배율</th>
                <th className="px-3 py-2 font-medium">법적 근거</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">
                    {DAY_TYPE_LABELS[r.day_type] ?? r.day_type}{' '}
                    {/* from_hour is the boundary, so an open band starting
                        at 1 is the second hour onward, not the first. */}
                    {r.to_hour === null
                      ? `${r.from_hour + 1}시간째부터`
                      : r.from_hour === 0
                        ? `첫 ${r.to_hour}시간 이내`
                        : `${r.from_hour + 1}~${r.to_hour}시간`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {/* The holiday band is quoted as a range in the regulation.
                        Showing a single number here would be the screen picking
                        a point the rule has not settled. */}
                    {r.multiplier_max
                      ? `×${r.multiplier} ~ ×${r.multiplier_max}`
                      : `×${r.multiplier}`}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">{r.legal_basis ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="text-xs text-neutral-500">시급 산식 분모 (월급여 ÷ 이 값)</span>
          <input
            type="number"
            min={1}
            max={173}
            step={1}
            value={divisor}
            disabled={!canEdit}
            onChange={(e) => setDivisor(Number(e.target.value))}
            className={`${input} w-32 text-right`}
          />
        </label>
        {mode === 'fixed_hourly' && (
          <label className="block">
            <span className="text-xs text-neutral-500">시간당 고정 요율 (Rp)</span>
            <input
              type="number"
              min={0}
              step={100}
              value={fixed}
              disabled={!canEdit}
              onChange={(e) => setFixed(Number(e.target.value))}
              className={`${input} w-40 text-right`}
            />
          </label>
        )}
        {canEdit && (
          <button
            disabled={busy}
            onClick={() =>
              save(() =>
                updateOtPolicyAction({
                  otMode: mode as 'multiplier' | 'fixed_hourly',
                  otHourDivisor: divisor,
                  otFixedHourlyRate: mode === 'fixed_hourly' ? fixed : null,
                })
              )
            }
            className={primary}
          >
            저장
          </button>
        )}
      </div>
      <Status note={note} error={error} />
    </section>
  );
}

/* --- 직급별 초과근무 대상 ------------------------------------------------- */

export function PositionOtSection({
  rows,
  canEdit,
}: {
  rows: PositionRow[];
  canEdit: boolean;
}) {
  const { busy, note, error, save } = useSaver();
  const [state, setState] = useState<Record<string, boolean>>(
    Object.fromEntries(rows.map((r) => [r.id, r.ot_eligible]))
  );
  const dirty = rows.some((r) => state[r.id] !== r.ot_eligible);

  return (
    <section>
      <h2 className="text-lg font-semibold">직급별 초과근무 대상</h2>
      <p className="mt-1 text-sm text-neutral-500">
        직급에 따라 초과근무 수당 지급 대상이 다를 수 있습니다. 관리직은 일반적으로 고정급으로
        제외됩니다.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">등록된 직급이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">직급</th>
                <th className="px-3 py-2 text-right font-medium">등급</th>
                <th className="px-3 py-2 font-medium">OT 대상</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                    {r.grade_level ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={state[r.id] ?? r.ot_eligible}
                        disabled={!canEdit}
                        onChange={(e) =>
                          setState((prev) => ({ ...prev, [r.id]: e.target.checked }))
                        }
                      />
                      <span className="text-neutral-500">
                        {(state[r.id] ?? r.ot_eligible) ? '대상' : '제외 (고정급)'}
                      </span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && rows.length > 0 && (
        <button
          disabled={busy || !dirty}
          onClick={() =>
            save(() =>
              updatePositionOtAction(
                rows
                  .filter((r) => state[r.id] !== r.ot_eligible)
                  .map((r) => ({ id: r.id, ot_eligible: state[r.id] }))
              )
            )
          }
          className={`mt-3 ${primary}`}
        >
          저장
        </button>
      )}
      <Status note={note} error={error} />
    </section>
  );
}

/* --- 급여 항목 마스터 ----------------------------------------------------- */

export function PayComponentSection({
  rows,
  usedCodes,
  canEdit,
}: {
  rows: PayComponentRow[];
  usedCodes: string[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<PayComponentRow | 'new' | null>(null);
  const used = new Set(usedCodes);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">급여 항목 마스터</h2>
        {canEdit && (
          <button
            onClick={() => setEditing(editing === 'new' ? null : 'new')}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
          >
            {editing === 'new' ? '닫기' : '+ 항목 추가'}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        수당과 공제를 함께 관리합니다. 항목별로 과세여부, BPJS 부과기준, 반복·1회성, 일할계산,
        Gross-up, 부담 주체를 설정합니다.
      </p>

      {editing === 'new' && <ComponentForm onDone={() => setEditing(null)} />}

      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">등록된 항목이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">항목명</th>
                <th className="px-3 py-2 font-medium">구분</th>
                <th className="px-3 py-2 font-medium">기준/금액</th>
                <th className="px-3 py-2 font-medium">속성</th>
                <th className="px-3 py-2 font-medium">상태</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">
                    {r.name}
                    <span className="ml-2 font-mono text-xs text-neutral-500">{r.code}</span>
                  </td>
                  <td className="px-3 py-2">
                    {r.kind === 'earning' ? '수당' : '공제'} ·{' '}
                    {r.recurring ? '반복' : '1회성'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.calc_type === 'formula'
                      ? (r.formula ?? '수식')
                      : r.calc_type === 'rate_of_base'
                        ? `기본급의 ${r.amount}%`
                        : formatRupiah(r.amount)}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {[
                      r.taxable ? '과세' : '비과세',
                      r.bpjs_base ? 'BPJS포함' : 'BPJS미포함',
                      r.prorate ? '일할O' : '일할X',
                      r.gross_up ? 'Gross-up' : null,
                      r.borne_by === 'employee'
                        ? '직원부담'
                        : r.borne_by === 'employer'
                          ? '회사부담'
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="px-3 py-2">
                    {r.active ? '사용중' : '미사용'}
                    {/* Marked because what can be edited depends on it. */}
                    {used.has(r.code) && (
                      <span className="ml-2 text-xs text-neutral-500">계산 사용됨</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setEditing(editing === r ? null : r)}
                        className="text-sm text-blue-600 underline"
                      >
                        {editing === r ? '닫기' : '수정'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && editing !== 'new' && (
        <ComponentForm
          row={editing}
          locked={used.has(editing.code)}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ComponentForm({
  row,
  locked,
  onDone,
}: {
  row?: PayComponentRow;
  locked?: boolean;
  onDone: () => void;
}) {
  const { busy, note, error, save } = useSaver();
  const [f, setF] = useState<PayComponentInput>({
    id: row?.id,
    code: row?.code ?? '',
    name: row?.name ?? '',
    kind: (row?.kind as 'earning' | 'deduction') ?? 'earning',
    calc_type: (row?.calc_type as PayComponentInput['calc_type']) ?? 'fixed',
    amount: row?.amount ?? 0,
    formula: row?.formula ?? null,
    taxable: row?.taxable ?? true,
    bpjs_base: row?.bpjs_base ?? true,
    prorate: row?.prorate ?? true,
    recurring: row?.recurring ?? true,
    gross_up: row?.gross_up ?? false,
    borne_by: (row?.borne_by as PayComponentInput['borne_by']) ?? 'none',
    active: row?.active ?? true,
  });
  const set = <K extends keyof PayComponentInput>(k: K, v: PayComponentInput[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      {locked && (
        /* Editing a component a closed payslip already used would rewrite what
           that payslip meant. */
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-500">
          이미 계산에 사용된 항목입니다. 마감된 명세서의 의미가 바뀌므로 사용 여부만 변경할 수
          있습니다. 조건을 바꾸려면 새 코드로 항목을 만드세요.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-neutral-500">코드</span>
          <input
            value={f.code}
            disabled={Boolean(row)}
            onChange={(e) => set('code', e.target.value)}
            className={`${input} w-full font-mono`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-neutral-500">항목명</span>
          <input
            value={f.name}
            disabled={locked}
            onChange={(e) => set('name', e.target.value)}
            className={`${input} w-full`}
          />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">구분</span>
          <select
            value={f.kind}
            disabled={locked}
            onChange={(e) => set('kind', e.target.value as 'earning' | 'deduction')}
            className={`${input} w-full`}
          >
            <option value="earning">수당</option>
            <option value="deduction">공제</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">계산 방식</span>
          <select
            value={f.calc_type}
            disabled={locked}
            onChange={(e) => set('calc_type', e.target.value as PayComponentInput['calc_type'])}
            className={`${input} w-full`}
          >
            <option value="fixed">고정 금액</option>
            <option value="rate_of_base">기본급 비율</option>
            <option value="per_attendance">근태 연동</option>
            <option value="formula">수식</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">
            {f.calc_type === 'formula' ? '수식' : f.calc_type === 'rate_of_base' ? '비율 (%)' : '금액 (Rp)'}
          </span>
          {f.calc_type === 'formula' ? (
            <input
              value={f.formula ?? ''}
              disabled={locked}
              onChange={(e) => set('formula', e.target.value)}
              className={`${input} w-full`}
            />
          ) : (
            <input
              type="number"
              min={0}
              value={f.amount ?? 0}
              disabled={locked}
              onChange={(e) => set('amount', Number(e.target.value))}
              className={`${input} w-full text-right`}
            />
          )}
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Toggle label="과세 대상" v={f.taxable} disabled={locked} on={(v) => set('taxable', v)} />
        <Toggle label="BPJS 부과" v={f.bpjs_base} disabled={locked} on={(v) => set('bpjs_base', v)} />
        <Toggle label="일할계산" v={f.prorate} disabled={locked} on={(v) => set('prorate', v)} />
        <Toggle label="반복 지급" v={f.recurring} disabled={locked} on={(v) => set('recurring', v)} />
        <Toggle label="Gross-up" v={f.gross_up} disabled={locked} on={(v) => set('gross_up', v)} />
        <Toggle label="사용" v={f.active} on={(v) => set('active', v)} />
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">부담 주체</span>
          <select
            value={f.borne_by}
            disabled={locked}
            onChange={(e) => set('borne_by', e.target.value as PayComponentInput['borne_by'])}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="none">없음</option>
            <option value="employee">직원 부담</option>
            <option value="employer">회사 부담</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          disabled={busy}
          onClick={() => save(() => savePayComponentAction(f).then((r) => (r.ok && !r.error ? (onDone(), r) : r)))}
          className={primary}
        >
          저장
        </button>
        <button onClick={onDone} className="text-sm text-neutral-500 underline">
          취소
        </button>
      </div>
      <Status note={note} error={error} />
    </div>
  );
}

function Toggle({
  label,
  v,
  disabled,
  on,
}: {
  label: string;
  v: boolean;
  disabled?: boolean;
  on: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={v} disabled={disabled} onChange={(e) => on(e.target.checked)} />
      {label}
    </label>
  );
}

/* --- 비례배분(Proration) 기준 --------------------------------------------- */

export function ProrationSection({
  companyBasis,
  departments,
  canEdit,
}: {
  companyBasis: string;
  departments: DepartmentRow[];
  canEdit: boolean;
}) {
  const { busy, note, error, save } = useSaver();
  const [basis, setBasis] = useState(companyBasis);
  const [overrides, setOverrides] = useState<Record<string, string>>(
    Object.fromEntries(departments.map((d) => [d.id, d.proration_basis ?? '']))
  );

  return (
    <section>
      <h2 className="text-lg font-semibold">비례배분(Proration) 기준</h2>
      <p className="mt-1 text-sm text-neutral-500">
        입사·퇴사·휴직으로 인한 일할 계산의 기준입니다. 부서별로 회사 기본값과 다르게 설정할 수
        있습니다.
      </p>

      <label className="mt-3 block max-w-xs">
        <span className="text-xs text-neutral-500">회사 기본값</span>
        <select
          value={basis}
          disabled={!canEdit}
          onChange={(e) => setBasis(e.target.value)}
          className={`${input} w-full`}
        >
          {Object.entries(PRORATION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>

      {departments.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">부서</th>
                <th className="px-3 py-2 font-medium">기준</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-2">{d.name}</td>
                  <td className="px-3 py-2">
                    <select
                      value={overrides[d.id] ?? ''}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setOverrides((prev) => ({ ...prev, [d.id]: e.target.value }))
                      }
                      className="rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
                    >
                      {/* Empty means "follow the company", not a copy of its
                          current value — a copy stops tracking the moment the
                          company default changes. */}
                      <option value="">회사 기본값 따름 ({PRORATION_LABELS[basis]})</option>
                      {Object.entries(PRORATION_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <button
          disabled={busy}
          onClick={() =>
            save(() =>
              updateProrationAction({
                companyBasis: basis as 'calendar' | 'fixed_30' | 'working_days',
                departments: departments.map((d) => ({
                  id: d.id,
                  basis: (overrides[d.id] || null) as
                    | 'calendar'
                    | 'fixed_30'
                    | 'working_days'
                    | null,
                })),
              })
            )
          }
          className={`mt-3 ${primary}`}
        >
          저장
        </button>
      )}
      <Status note={note} error={error} />
    </section>
  );
}

/* --- 변경 이력 ------------------------------------------------------------ */

const AUDIT_LABELS: Record<string, string> = {
  TAX_TABLE_UPLOADED: 'PPh 21 세율표 등록',
  UMK_UPDATED: 'UMK 변경',
  PAYROLL_POLICY_UPDATED: '급여 정책 변경',
  CREDIT_WEIGHTS_UPDATED: '신용점수 가중치 조정',
  OT_POLICY_UPDATED: 'OT 정책 변경',
  POSITION_OT_UPDATED: '직급별 OT 대상 변경',
  PRORATION_POLICY_UPDATED: '비례배분 기준 변경',
  PAY_COMPONENT_CREATED: '급여 항목 추가',
  PAY_COMPONENT_UPDATED: '급여 항목 변경',
  PAYROLL_TYPE_UPDATED: '지급 유형 변경',
};

export function PolicyHistorySection({ rows }: { rows: AuditRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">변경 이력</h2>
      {/* Read from the audit log rather than a table of its own: a change
          history that can be written independently of the change is not a
          history. */}
      <p className="mt-1 text-sm text-neutral-500">
        이 화면에서 변경한 값은 다음 차수부터 적용되며, 이미 마감된 차수에는 소급되지 않습니다.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">기록된 변경이 없습니다.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {rows.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-neutral-500">
                {new Date(r.created_at).toLocaleString('ko-KR', {
                  year: '2-digit',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span>{r.actor_name ?? '—'}</span>
              <span className="text-neutral-600 dark:text-neutral-400">
                {AUDIT_LABELS[r.action] ?? r.action}
              </span>
              {r.details && Object.keys(r.details).length > 0 && (
                <span className="text-xs text-neutral-500">{summarise(r.details)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function summarise(details: Record<string, unknown>): string {
  const changed = details.changed as Record<string, string> | undefined;
  if (changed) return Object.values(changed).join(' · ');
  return Object.entries(details)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}
