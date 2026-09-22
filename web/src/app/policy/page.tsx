import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import {
  PolicyPanel,
  type BpjsRow,
  type CreditFactorRow,
  type UmkRow,
  type TaxVersion,
} from '@/components/policy-panel';

export default async function PolicyPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const supabase = await createClient();
  const [bpjsRes, umkRes, taxRes, policyRes, ruleRes, factorRes] = await Promise.all([
    supabase.from('bpjs_rates').select('*').is('effective_to', null).order('program'),
    supabase.from('umk_rates').select('region, amount, year').order('region'),
    supabase
      .from('tax_tables')
      .select('version, category, effective_from, effective_to')
      .order('effective_from', { ascending: false }),
    supabase
      .from('payroll_policies')
      .select('max_loan_deduction_rate, weekly_ot_cap_minutes')
      .maybeSingle(),
    supabase.from('gate_rules').select('threshold').eq('code', 'G3_NET_VARIANCE').maybeSingle(),
    supabase
      .from('credit_score_factors')
      .select('code, name, weight, max_points, source')
      .eq('active', true)
      .order('weight', { ascending: false }),
  ]);

  // Rolled up here rather than in SQL: the row count per version is what the
  // screen shows, and a grouped query would be a second round trip for two
  // numbers.
  const byVersion = new Map<string, TaxVersion>();
  for (const row of taxRes.data ?? []) {
    const v = row.version as string;
    const entry = byVersion.get(v) ?? {
      version: v,
      effective_from: row.effective_from as string,
      effective_to: (row.effective_to as string | null) ?? null,
      bands: 0,
      categories: [],
    };
    entry.bands += 1;
    const category = row.category as string | null;
    if (category && !entry.categories.includes(category)) entry.categories.push(category);
    byVersion.set(v, entry);
  }
  const taxVersions = [...byVersion.values()].map((v) => ({
    ...v,
    categories: v.categories.sort(),
  }));

  const isOperator = session.role === 'operator_admin';
  const canEditPolicy = isOperator || session.role === 'hr_admin';

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="flex gap-4 text-sm">
        <Link href="/employees" className="text-blue-600 underline">
          ← 직원 목록
        </Link>
        <Link href="/attendance" className="text-blue-600 underline">
          근태 마감
        </Link>
      </div>

      <h1 className="mt-4 text-2xl font-semibold">정책 · 요율</h1>
      <p className="mt-1 text-sm text-neutral-500">
        급여 계산이 근거로 삼는 값들입니다. 법정 요율은 운영사가, 회사 정책은 HR이 관리합니다.
      </p>

      <PolicyPanel
        bpjs={(bpjsRes.data ?? []) as BpjsRow[]}
        umk={(umkRes.data ?? []) as UmkRow[]}
        taxVersions={taxVersions}
        policy={{
          varianceThreshold: Number(ruleRes.data?.threshold ?? 20),
          maxLoanDeductionRate: Number(policyRes.data?.max_loan_deduction_rate ?? 30),
          weeklyOtCapHours: Math.round((policyRes.data?.weekly_ot_cap_minutes ?? 1080) / 60),
        }}
        creditFactors={((factorRes.data ?? []) as unknown as CreditFactorRow[]).map((f) => ({
          ...f,
          weight: Number(f.weight),
          max_points: Number(f.max_points),
        }))}
        isOperator={isOperator}
        canEditPolicy={canEditPolicy}
      />
    </main>
  );
}
