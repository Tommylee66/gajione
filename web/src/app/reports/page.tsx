import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { CATEGORIES } from '@/lib/reports/catalogue';
import { ReportPanel, type RunOption } from '@/components/report-panel';

export const dynamic = 'force-dynamic';

const ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];

const RUN_TYPE_LABELS: Record<string, string> = {
  regular: '정기급여',
  thr: 'THR',
  bonus: '상여금',
  resignation: '퇴직정산',
  correction: '정정',
};

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!ROLES.includes(session.role)) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">리포트</h1>
        <p className="mt-3 text-sm text-neutral-500">이 화면을 볼 권한이 없습니다.</p>
      </main>
    );
  }

  const supabase = await createClient();
  const { data: runRows } = await supabase
    .from('payroll_runs')
    .select('id, period, run_type, seq, status')
    .order('period', { ascending: false })
    .order('seq', { ascending: false })
    .limit(36);

  const runs: RunOption[] = (runRows ?? []).map((r) => ({
    id: r.id as string,
    label:
      `${r.period}` +
      (r.run_type !== 'regular' ? ` ${RUN_TYPE_LABELS[r.run_type as string] ?? r.run_type}` : '') +
      (Number(r.seq) > 1 ? ` #${r.seq}` : '') +
      (r.status === 'locked' ? ' (마감)' : ' (진행중)'),
  }));

  // Years that actually have runs, newest first. Offering a year with no data
  // is offering an empty file.
  const years = [
    ...new Set((runRows ?? []).map((r) => Number(String(r.period).slice(0, 4)))),
  ].sort((a, b) => b - a);
  if (years.length === 0) years.push(new Date().getFullYear());

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">리포트</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {CATEGORIES.length}개 카테고리 · 급여·세금·BPJS·인사·근태 등 항목별 리포트를 조회하고
        내려받습니다.
      </p>

      <ReportPanel runs={runs} years={years} />
    </main>
  );
}
