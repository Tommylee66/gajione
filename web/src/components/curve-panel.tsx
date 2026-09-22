'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateCreditCurvesAction } from '@/app/policy/actions';
import {
  CURVE_FIELDS,
  previewCurve,
  validateCurve,
  withDefaults,
  type Curve,
} from '@/lib/credit/curves';
import { normalizeSample } from '@/lib/credit/scoring';

export interface CurveFactorRow {
  code: string;
  name: string;
  curve: Record<string, unknown> | null;
}

const input =
  'mt-1 block w-28 rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-right disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950';

export function CurvePanel({ rows, canEdit }: { rows: CurveFactorRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, Curve>>(
    Object.fromEntries(rows.map((r) => [r.code, withDefaults(r.code, r.curve)]))
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problems = rows.flatMap((r) => validateCurve(r.code, state[r.code] ?? {}));
  const dirty = rows.some(
    (r) => JSON.stringify(state[r.code]) !== JSON.stringify(withDefaults(r.code, r.curve))
  );

  async function save() {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await updateCreditCurvesAction(
      rows.map((x) => ({ code: x.code, curve: state[x.code] }))
    );
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '저장에 실패했습니다.');
    setNote('저장했습니다.');
    router.refresh();
  }

  if (rows.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold">신용점수 산출 곡선</h2>
      <p className="mt-1 text-sm text-neutral-500">
        각 항목의 원자료를 0~100점으로 환산하는 기준입니다. 출근율 1%p가 몇 점인지, 연체 1회가
        얼마인지는 신용리스크 판단이라 여기서 정합니다.
      </p>
      {/* Changing a curve does not rewrite anything already decided. */}
      <p className="mt-1 text-sm text-neutral-500">
        이미 산출된 점수는 바뀌지 않습니다. 다음 산출부터 적용되며, 전 테넌트 공통이라 운영사만
        변경할 수 있습니다.
      </p>

      <div className="mt-4 space-y-6">
        {rows.map((r) => {
          const curve = state[r.code] ?? {};
          const fields = CURVE_FIELDS[r.code] ?? [];
          const preview = previewCurve(r.code, curve, normalizeSample);
          const mine = problems.filter((p) => p.code === r.code);
          return (
            <div
              key={r.code}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <h3 className="text-base font-semibold">{r.name}</h3>
              <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_240px]">
                <div className="space-y-3">
                  {fields.map((f) => (
                    <label key={f.key} className="block">
                      <span className="text-sm">{f.label}</span>
                      {f.help && (
                        <span className="mt-0.5 block text-xs text-neutral-500">{f.help}</span>
                      )}
                      {f.type === 'boolean' ? (
                        <span className="mt-1 flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={Boolean(curve[f.key])}
                            disabled={!canEdit}
                            onChange={(e) =>
                              setState((p) => ({
                                ...p,
                                [r.code]: { ...p[r.code], [f.key]: e.target.checked },
                              }))
                            }
                          />
                          {curve[f.key] ? '적용' : '미적용'}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min={f.min}
                          max={f.max}
                          step={f.step}
                          value={Number(curve[f.key] ?? 0)}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setState((p) => ({
                              ...p,
                              [r.code]: { ...p[r.code], [f.key]: Number(e.target.value) },
                            }))
                          }
                          className={input}
                        />
                      )}
                    </label>
                  ))}
                </div>

                {/* Run through the same functions the scorer uses, so what is
                    shown here is what the model will do. */}
                <div className="rounded-md bg-neutral-50 p-3 dark:bg-neutral-900">
                  <p className="text-xs font-medium text-neutral-500">적용 결과 미리보기</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {preview.map((row) => (
                      <li key={row.input} className="flex justify-between gap-3">
                        <span className="text-neutral-600 dark:text-neutral-400">{row.input}</span>
                        <span className="tabular-nums">{row.score.toFixed(0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {mine.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-red-600">
                  {mine.map((p) => (
                    <li key={p.key}>· {p.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            disabled={busy || !dirty || problems.length > 0}
            onClick={save}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            저장
          </button>
          {note && <span className="text-sm text-neutral-500">{note}</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      )}
    </section>
  );
}
