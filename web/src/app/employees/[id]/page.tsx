import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession, canSeeSensitive } from '@/lib/auth/session';
import { getEmployee, listSalaryHistory } from '@/lib/data-access/employees';
import { listDepartments, listPositions } from '@/lib/data-access/org';
import { formatRupiah, formatDate, employmentLabel } from '@/lib/format';
import { SalaryChange } from '@/components/salary-change';

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const supabase = await createClient();
  const employee = await getEmployee(supabase, id, session);
  if (!employee) notFound();

  const sensitive = canSeeSensitive(session.role) || session.employee_id === employee.id;
  const canEdit = session.role === 'hr_admin' || session.role === 'operator_admin';

  // Salary history is only fetched for viewers allowed to see amounts. Reading
  // it and hiding it in the component would still ship the numbers.
  const [departments, positions, history] = await Promise.all([
    listDepartments(supabase),
    listPositions(supabase),
    sensitive ? listSalaryHistory(supabase, id) : Promise.resolve([]),
  ]);

  const department = departments.find((d) => d.id === employee.department_id);
  const position = positions.find((p) => p.id === employee.position_id);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <Link href="/employees" className="text-sm text-blue-600 underline">
        ← 직원 목록
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{employee.full_name}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {employee.employee_no} · {department?.name ?? '부서 미지정'} ·{' '}
            {position?.name ?? '직급 미지정'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {employee.resign_date && (
            <span className="rounded bg-neutral-200 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              {formatDate(employee.resign_date)} 퇴사
            </span>
          )}
          {canEdit && (
            <Link
              href={`/employees/${employee.id}/edit`}
              className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
            >
              정보 수정
            </Link>
          )}
        </div>
      </header>

      <section className="mt-8">
        <h2 className="text-base font-semibold">기본 정보</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field label="고용형태" value={employmentLabel(employee.employment_type)} />
          <Field label="입사일" value={formatDate(employee.join_date)} />
          <Field label="생년월일" value={formatDate(employee.birth_date)} />
          <Field label="성별" value={employee.gender === 'M' ? '남' : employee.gender === 'F' ? '여' : '—'} />
          <Field label="PTKP 구분" value={employee.ptkp_status ?? '—'} />
          <Field label="UMK 지역" value={employee.umk_region ?? '—'} />
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">
          신원·급여
          {!sensitive && (
            <span className="ml-2 text-xs font-normal text-neutral-500">
              권한에 따라 일부만 표시됩니다
            </span>
          )}
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field label="NIK (KTP)" value={employee.nik ?? '—'} mono />
          <Field label="NPWP" value={employee.npwp ?? '—'} mono />
          <Field
            label="기본급"
            value={sensitive ? formatRupiah(employee.base_salary) : '비공개'}
          />
        </dl>
      </section>

      {sensitive && (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">급여 변경 이력</h2>
            {canEdit && (
              <SalaryChange employeeId={employee.id} currentSalary={employee.base_salary} />
            )}
          </div>
          {history.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">기록이 없습니다.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                  <tr>
                    <th className="px-3 py-2 font-medium">효력일</th>
                    <th className="px-3 py-2 text-right font-medium">이전</th>
                    <th className="px-3 py-2 text-right font-medium">변경</th>
                    <th className="px-3 py-2 text-right font-medium">변동률</th>
                    <th className="px-3 py-2 font-medium">사유</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-t border-neutral-200 dark:border-neutral-800">
                      <td className="px-3 py-2">{formatDate(h.effective_date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatRupiah(h.previous_amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatRupiah(h.new_amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {h.change_rate === null ? '—' : `${h.change_rate.toFixed(1)}%`}
                      </td>
                      <td className="px-3 py-2">{h.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            품질게이트 G3의 ±20% 변동 검출이 이 이력을 근거로 삼습니다.
          </p>
        </section>
      )}
    </main>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-neutral-500">{label}</dt>
      <dd className={`mt-0.5 text-sm ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
