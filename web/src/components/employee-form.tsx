'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Department, Employee, Position } from '@/types/domain';
import {
  createEmployeeAction,
  updateEmployeeAction,
  type EmployeeFormValues,
} from '@/app/employees/actions';

interface Props {
  departments: Department[];
  positions: Position[];
  /** Absent when creating. */
  employee?: Employee;
  defaultUmkRegion?: string | null;
}

const EMPLOYMENT_OPTIONS: { value: Employee['employment_type']; label: string }[] = [
  { value: 'permanent', label: '정규직' },
  { value: 'contract', label: '계약직' },
  { value: 'probation', label: '수습' },
  { value: 'daily', label: '일용직' },
  { value: 'intern', label: '인턴' },
];

// The PTKP status decides the tax-free allowance, so PPh 21 cannot be computed
// without it. Offered as a list rather than free text because a typo here is
// invisible until the tax is wrong.
const PTKP_OPTIONS = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'];

export function EmployeeForm({ departments, positions, employee, defaultUmkRegion }: Props) {
  const router = useRouter();
  const editing = Boolean(employee);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const values = {
      employee_no: String(fd.get('employee_no') ?? ''),
      full_name: String(fd.get('full_name') ?? ''),
      nik: String(fd.get('nik') ?? ''),
      npwp: String(fd.get('npwp') ?? ''),
      birth_date: String(fd.get('birth_date') ?? ''),
      gender: (fd.get('gender') as 'M' | 'F' | '') || null,
      join_date: String(fd.get('join_date') ?? ''),
      employment_type: fd.get('employment_type') as Employee['employment_type'],
      department_id: String(fd.get('department_id') ?? ''),
      position_id: String(fd.get('position_id') ?? ''),
      ptkp_status: String(fd.get('ptkp_status') ?? ''),
      umk_region: String(fd.get('umk_region') ?? ''),
    } satisfies EmployeeFormValues;

    const result = editing
      ? await updateEmployeeAction(employee!.id, values)
      : await createEmployeeAction({
          ...values,
          base_salary: Number(fd.get('base_salary') ?? 0),
        });

    if (!result.ok) {
      setError(result.error ?? '처리에 실패했습니다.');
      setBusy(false);
      return;
    }
    router.push(`/employees/${result.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-8">
      <section>
        <h2 className="text-base font-semibold">기본 정보</h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="사번" required>
            <input name="employee_no" required defaultValue={employee?.employee_no} className={input} />
          </Field>
          <Field label="이름" required>
            <input name="full_name" required defaultValue={employee?.full_name} className={input} />
          </Field>
          <Field label="입사일" required>
            <input type="date" name="join_date" required defaultValue={employee?.join_date?.slice(0, 10)} className={input} />
          </Field>
          <Field label="고용형태">
            <select name="employment_type" defaultValue={employee?.employment_type ?? 'permanent'} className={input}>
              {EMPLOYMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="부서">
            <select name="department_id" defaultValue={employee?.department_id ?? ''} className={input}>
              <option value="">미지정</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="직급">
            <select name="position_id" defaultValue={employee?.position_id ?? ''} className={input}>
              <option value="">미지정</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.ot_eligible ? '' : ' (OT 제외)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="생년월일">
            <input type="date" name="birth_date" defaultValue={employee?.birth_date?.slice(0, 10) ?? ''} className={input} />
          </Field>
          <Field label="성별">
            <select name="gender" defaultValue={employee?.gender ?? ''} className={input}>
              <option value="">미지정</option>
              <option value="M">남</option>
              <option value="F">여</option>
            </select>
          </Field>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">신원·세무</h2>
        <p className="mt-1 text-xs text-neutral-500">
          NIK와 NPWP는 특정 개인정보입니다. 권한이 낮은 역할에게는 일부만 표시됩니다.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="NIK (KTP, 숫자 16자리)">
            <input
              name="nik"
              inputMode="numeric"
              maxLength={16}
              defaultValue={employee?.nik ?? ''}
              className={`${input} font-mono`}
            />
          </Field>
          <Field label="NPWP">
            <input name="npwp" defaultValue={employee?.npwp ?? ''} className={`${input} font-mono`} />
          </Field>
          <Field label="PTKP 구분">
            <select name="ptkp_status" defaultValue={employee?.ptkp_status ?? ''} className={input}>
              <option value="">미지정</option>
              {PTKP_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="UMK 지역">
            <input
              name="umk_region"
              defaultValue={employee?.umk_region ?? defaultUmkRegion ?? ''}
              className={input}
            />
          </Field>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">급여</h2>
        {editing ? (
          // Deliberately not editable here. Changing pay writes a history row
          // that G3 reads, so it goes through its own action on the detail
          // page rather than being buried among address changes.
          <p className="mt-2 rounded-md bg-neutral-50 p-3 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            기본급은 이 화면에서 바꾸지 않습니다. 변경 이력이 남아야 하고 품질게이트 G3의 ±20%
            검출이 그 이력을 근거로 삼기 때문에, 상세 화면의 <b>급여 변경</b>에서 사유와 함께
            입력합니다.
          </p>
        ) : (
          <div className="mt-3 max-w-xs">
            <Field label="기본급 (Rp)" required>
              <input
                type="number"
                name="base_salary"
                required
                min={0}
                step={1000}
                defaultValue={0}
                className={`${input} text-right tabular-nums`}
              />
            </Field>
          </div>
        )}
      </section>

      {error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? '저장 중…' : editing ? '수정' : '등록'}
        </button>
        <Link
          href={employee ? `/employees/${employee.id}` : '/employees'}
          className="rounded-md border border-neutral-300 px-5 py-2 text-sm dark:border-neutral-700"
        >
          취소
        </Link>
      </div>
    </form>
  );
}

const input =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-500">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
