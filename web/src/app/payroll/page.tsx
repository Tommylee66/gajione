import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { PayrollRuns, type RunRow } from '@/components/payroll-runs';

export default async function PayrollPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const supabase = await createClient();
  const { data } = await supabase
    .from('payroll_runs')
    .select('*')
    .order('period', { ascending: false });

  const canRun = ['hr_admin', 'payroll_staff', 'operator_admin'].includes(session.role);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="flex gap-4 text-sm">
        <Link href="/employees" className="text-blue-600 underline">← 직원 목록</Link>
        <Link href="/attendance" className="text-blue-600 underline">근태 마감</Link>
        <Link href="/policy" className="text-blue-600 underline">정책 · 요율</Link>
      </div>
      <h1 className="mt-4 text-2xl font-semibold">급여 계산 (G2)</h1>
      <p className="mt-1 text-sm text-neutral-500">
        마감된 근태를 입력으로 계산합니다. 같은 입력으로 두 번 계산해 결과가 일치할 때만
        저장됩니다.
      </p>
      <PayrollRuns runs={(data ?? []) as RunRow[]} canRun={canRun} />
    </main>
  );
}
