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
import {
  OtSection,
  PayComponentSection,
  PayrollTypeSection,
  PolicyHistorySection,
  PositionOtSection,
  ProrationSection,
  type AuditRow,
  type DepartmentRow,
  type OtRuleRow,
  type PayComponentRow,
  type PayrollTypeRow,
  type PositionRow,
} from '@/components/policy-extra';

export default async function PolicyPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const supabase = await createClient();
  const [
    bpjsRes,
    umkRes,
    taxRes,
    policyRes,
    ruleRes,
    factorRes,
    otRes,
    positionRes,
    deptRes,
    componentRes,
    typeRes,
    auditRes,
    lineRes,
  ] = await Promise.all([
    supabase.from('bpjs_rates').select('*').is('effective_to', null).order('program'),
    supabase.from('umk_rates').select('region, amount, year').order('region'),
    supabase
      .from('tax_tables')
      .select('version, category, effective_from, effective_to')
      .order('effective_from', { ascending: false }),
    supabase
      .from('payroll_policies')
      .select('max_loan_deduction_rate, weekly_ot_cap_minutes, ot_mode, ot_hour_divisor, ot_fixed_hourly_rate, proration_basis')
      .maybeSingle(),
    supabase.from('gate_rules').select('threshold').eq('code', 'G3_NET_VARIANCE').maybeSingle(),
    supabase
      .from('credit_score_factors')
      .select('code, name, weight, max_points, source')
      .eq('active', true)
      .order('weight', { ascending: false }),
    supabase
      .from('ot_rate_rules')
      .select('day_type, from_hour, to_hour, multiplier, multiplier_max, legal_basis')
      .is('effective_to', null)
      .order('day_type')
      .order('from_hour'),
    supabase.from('positions').select('id, name, grade_level, ot_eligible').eq('active', true).order('grade_level'),
    supabase.from('departments').select('id, name, proration_basis').eq('active', true).order('name'),
    supabase.from('pay_components').select('*').order('kind').order('sort_order'),
    supabase.from('payroll_type_settings').select('*').order('run_type'),
    supabase
      .from('audit_log')
      .select('action, created_at, actor_id, details')
      .in('action', [
        'TAX_TABLE_UPLOADED', 'UMK_UPDATED', 'PAYROLL_POLICY_UPDATED', 'CREDIT_WEIGHTS_UPDATED',
        'OT_POLICY_UPDATED', 'POSITION_OT_UPDATED', 'PRORATION_POLICY_UPDATED',
        'PAY_COMPONENT_CREATED', 'PAY_COMPONENT_UPDATED', 'PAYROLL_TYPE_UPDATED',
      ])
      .order('created_at', { ascending: false })
      .limit(20),
    // Which component codes a payslip has already used. An in-use component
    // may be switched off but not redefined.
    supabase.from('payroll_lines').select('component_code'),
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

  // Actor names are looked up rather than stored on the log line: an audit
  // entry records who acted, and a name copied at write time would drift from
  // the person record.
  const actorIds = [
    ...new Set((auditRes.data ?? []).map((a) => a.actor_id as string | null).filter(Boolean)),
  ] as string[];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await supabase.from('users').select('id, full_name').in('id', actorIds);
    for (const a of actors ?? []) actorNames.set(a.id as string, a.full_name as string);
  }
  const auditRows: AuditRow[] = (auditRes.data ?? []).map((a) => ({
    action: a.action as string,
    created_at: a.created_at as string,
    actor_name: a.actor_id ? (actorNames.get(a.actor_id as string) ?? null) : null,
    details: (a.details as Record<string, unknown> | null) ?? null,
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

      <div className="mt-12 space-y-12">
        <PayrollTypeSection
          rows={(typeRes.data ?? []) as unknown as PayrollTypeRow[]}
          canEdit={canEditPolicy}
        />
        <OtSection
          rules={((otRes.data ?? []) as unknown as OtRuleRow[]).map((r) => ({
            ...r,
            from_hour: Number(r.from_hour),
            to_hour: r.to_hour === null ? null : Number(r.to_hour),
            multiplier: Number(r.multiplier),
            multiplier_max: r.multiplier_max === null ? null : Number(r.multiplier_max),
          }))}
          policy={{
            otMode: (policyRes.data?.ot_mode as string) ?? 'multiplier',
            otHourDivisor: Number(policyRes.data?.ot_hour_divisor ?? 173),
            otFixedHourlyRate:
              policyRes.data?.ot_fixed_hourly_rate === null ||
              policyRes.data?.ot_fixed_hourly_rate === undefined
                ? null
                : Number(policyRes.data.ot_fixed_hourly_rate),
          }}
          canEdit={canEditPolicy}
        />
        <PositionOtSection
          rows={(positionRes.data ?? []) as unknown as PositionRow[]}
          canEdit={canEditPolicy}
        />
        <PayComponentSection
          rows={((componentRes.data ?? []) as unknown as PayComponentRow[]).map((r) => ({
            ...r,
            amount: r.amount === null ? null : Number(r.amount),
          }))}
          usedCodes={[
            ...new Set(
              (lineRes.data ?? [])
                .map((l) => l.component_code as string | null)
                .filter((c): c is string => Boolean(c))
            ),
          ]}
          canEdit={canEditPolicy}
        />
        <ProrationSection
          companyBasis={(policyRes.data?.proration_basis as string) ?? 'calendar'}
          departments={(deptRes.data ?? []) as unknown as DepartmentRow[]}
          canEdit={canEditPolicy}
        />
        <PolicyHistorySection rows={auditRows} />
      </div>
    </main>
  );
}
