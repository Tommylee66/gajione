'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Department, Position } from '@/types/domain';
import {
  createDepartmentAction,
  createPositionAction,
  setDepartmentActiveAction,
  setPositionActiveAction,
  setPositionOtEligibleAction,
} from '@/app/org/actions';

interface Props {
  departments: Department[];
  positions: Position[];
  /** Headcount by id, so nothing is deactivated blind. */
  deptUsage: Record<string, number>;
  posUsage: Record<string, number>;
  canEdit: boolean;
}

export function OrgManager({ departments, positions, deptUsage, posUsage, canEdit }: Props) {
  return (
    <div className="mt-8 space-y-12">
      <DepartmentSection departments={departments} usage={deptUsage} canEdit={canEdit} />
      <PositionSection positions={positions} usage={posUsage} canEdit={canEdit} />
    </div>
  );
}

function DepartmentSection({
  departments,
  usage,
  canEdit,
}: {
  departments: Department[];
  usage: Record<string, number>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Parents first, then their lines indented under them. The mockup's org has
  // 조립 with 조립1 and 조립2 beneath it, and a flat list loses that.
  const roots = departments.filter((d) => !d.parent_id);
  const childrenOf = (id: string) => departments.filter((d) => d.parent_id === id);
  const ordered: { dept: Department; depth: number }[] = [];
  for (const root of roots) {
    ordered.push({ dept: root, depth: 0 });
    for (const child of childrenOf(root.id)) ordered.push({ dept: child, depth: 1 });
  }
  // Anything whose parent is missing or inactive would otherwise vanish.
  for (const d of departments) {
    if (d.parent_id && !ordered.some((o) => o.dept.id === d.id)) {
      ordered.push({ dept: d, depth: 1 });
    }
  }

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    const result = await createDepartmentAction({
      code: String(fd.get('code') ?? ''),
      name: String(fd.get('name') ?? ''),
      parent_id: String(fd.get('parent_id') ?? ''),
    });
    if (!result.ok) return setError(result.error ?? '등록에 실패했습니다.');
    form.reset();
    setOpen(false);
    router.refresh();
  }

  function toggle(id: string, active: boolean) {
    startTransition(async () => {
      const result = await setDepartmentActiveAction(id, active);
      if (!result.ok) setError(result.error ?? '처리에 실패했습니다.');
      router.refresh();
    });
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">부서 · 라인</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {departments.filter((d) => d.active).length}개 사용 중
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
          >
            {open ? '취소' : '부서 추가'}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={onCreate} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">코드</span>
            <input name="code" required placeholder="ASM" className={`${input} w-28`} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">부서명</span>
            <input name="name" required placeholder="조립" className={`${input} w-48`} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">상위 부서</span>
            <select name="parent_id" defaultValue="" className={`${input} w-40`}>
              <option value="">없음 (최상위)</option>
              {roots.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            추가
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">코드</th>
              <th className="px-3 py-2 font-medium">부서명</th>
              <th className="px-3 py-2 text-right font-medium">인원</th>
              <th className="px-3 py-2 font-medium">상태</th>
              {canEdit && <th className="w-28 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {ordered.map(({ dept, depth }) => (
              <tr key={dept.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2 font-mono text-xs">{dept.code}</td>
                <td className="px-3 py-2" style={{ paddingLeft: depth ? 28 : undefined }}>
                  {depth > 0 && <span className="mr-1 text-neutral-400">└</span>}
                  {dept.name}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{usage[dept.id] ?? 0}</td>
                <td className="px-3 py-2">
                  {dept.active ? (
                    <span className="text-neutral-600 dark:text-neutral-400">사용</span>
                  ) : (
                    <span className="text-neutral-400">미사용</span>
                  )}
                </td>
                {canEdit && (
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={pending}
                      onClick={() => toggle(dept.id, !dept.active)}
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                    >
                      {dept.active ? '미사용으로' : '다시 사용'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        부서는 삭제하지 않고 미사용으로 전환합니다. 외래키가 없는 스키마라 행을 지우면 그 부서에
        속한 직원 기록이 존재하지 않는 부서를 가리키게 되고, 과거 급여대장까지 부서가 빈 채로
        남습니다.
      </p>
    </section>
  );
}

function PositionSection({
  positions,
  usage,
  canEdit,
}: {
  positions: Position[];
  usage: Record<string, number>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    const grade = String(fd.get('grade_level') ?? '');
    const result = await createPositionAction({
      name: String(fd.get('name') ?? ''),
      grade_level: grade === '' ? null : Number(grade),
      ot_eligible: fd.get('ot_eligible') === 'on',
    });
    if (!result.ok) return setError(result.error ?? '등록에 실패했습니다.');
    form.reset();
    setOpen(false);
    router.refresh();
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? '처리에 실패했습니다.');
      router.refresh();
    });
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">직급</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {positions.filter((p) => p.active).length}개 사용 중
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
          >
            {open ? '취소' : '직급 추가'}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={onCreate} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">직급명</span>
            <input name="name" required placeholder="오퍼레이터" className={`${input} w-48`} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-500">등급</span>
            <input name="grade_level" type="number" className={`${input} w-24`} />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input name="ot_eligible" type="checkbox" defaultChecked />
            초과근무 대상
          </label>
          <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            추가
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">직급명</th>
              <th className="px-3 py-2 text-right font-medium">등급</th>
              <th className="px-3 py-2 text-right font-medium">인원</th>
              <th className="px-3 py-2 font-medium">초과근무</th>
              <th className="px-3 py-2 font-medium">상태</th>
              {canEdit && <th className="w-28 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">{p.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.grade_level ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{usage[p.id] ?? 0}</td>
                <td className="px-3 py-2">
                  {canEdit ? (
                    <button
                      disabled={pending}
                      onClick={() => run(() => setPositionOtEligibleAction(p.id, !p.ot_eligible))}
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                    >
                      {p.ot_eligible ? '대상' : '제외'}
                    </button>
                  ) : (
                    <span>{p.ot_eligible ? '대상' : '제외'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {p.active ? (
                    <span className="text-neutral-600 dark:text-neutral-400">사용</span>
                  ) : (
                    <span className="text-neutral-400">미사용</span>
                  )}
                </td>
                {canEdit && (
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={pending}
                      onClick={() => run(() => setPositionActiveAction(p.id, !p.active))}
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                    >
                      {p.active ? '미사용으로' : '다시 사용'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        초과근무 대상 여부는 직급의 속성입니다. 인도네시아 실무상 관리직은 초과근무 수당 대상이
        아니며, 이 값을 바꾸면 다음 차수부터 해당 직급 전원의 지급액이 달라집니다.
      </p>
    </section>
  );
}

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
