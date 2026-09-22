'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  calculate,
  batchHash,
  type EngineInput,
  type EngineAttendance,
  type EngineOutput,
} from '@/lib/payroll/engine';

const RUN_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];

async function requirePayrollRole() {
  const session = await requireSession();
  if (!RUN_ROLES.includes(session.role)) {
    throw new Error('Forbidden: 급여를 계산할 권한이 없습니다.');
  }
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  runId?: string;
  employees?: number;
  hashMatch?: boolean;
  warnings?: number;
}

function periodRange(period: string) {
  const [y, m] = period.split('-').map(Number);
  return {
    cutoffStart: new Date(Date.UTC(y, m - 2, 26)).toISOString().slice(0, 10),
    cutoffEnd: new Date(Date.UTC(y, m - 1, 25)).toISOString().slice(0, 10),
    payDate: new Date(Date.UTC(y, m - 1, 28)).toISOString().slice(0, 10),
  };
}

export async function createRunAction(period: string): Promise<RunResult> {
  try {
    const session = await requirePayrollRole();
    const { cutoffStart, cutoffEnd, payDate } = periodRange(period);
    const supabase = await createClient();

    const { data: existing } = await supabase
      .from('payroll_runs')
      .select('id')
      .eq('period', period)
      .eq('run_type', 'regular')
      .maybeSingle();
    if (existing) return { ok: false, error: `${period} 정기 차수가 이미 있습니다.`, runId: existing.id };

    const { data, error } = await supabase
      .from('payroll_runs')
      .insert({
        company_id: session.company_id,
        period,
        run_type: 'regular',
        seq: 1,
        cutoff_start: cutoffStart,
        cutoff_end: cutoffEnd,
        pay_date: payDate,
        status: 'draft',
        created_by: session.id,
      })
      .select('id')
      .single();
    if (error) throw error;

    revalidatePath('/payroll');
    return { ok: true, runId: data.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '차수 생성에 실패했습니다.' };
  }
}

/**
 * Computes a run twice and stores the result only if both passes agree.
 *
 * The engine is pure, so a mismatch means something non-deterministic reached
 * it — an unstable sort, a floating-point path that depends on iteration
 * order, a rate looked up by a moving date. Finding that here costs a rerun;
 * finding it after payment costs 412 corrections.
 */
export async function computeRunAction(runId: string): Promise<RunResult> {
  try {
    const session = await requirePayrollRole();
    const supabase = await createClient();

    const { data: run, error: runError } = await supabase
      .from('payroll_runs')
      .select('*')
      .eq('id', runId)
      .single();
    if (runError) throw runError;
    if (run.status === 'locked' || run.locked_at) {
      return { ok: false, error: '이미 마감된 차수는 다시 계산할 수 없습니다.' };
    }

    const input = await loadEngineInput(supabase, run);
    if ('error' in input) return { ok: false, error: input.error };

    const first = calculate(input.value);
    const second = calculate(input.value);
    const hash1 = batchHash(first);
    const hash2 = batchHash(second);
    const hashMatch = hash1 === hash2;

    await supabase.from('payroll_recalcs').upsert(
      [
        {
          company_id: session.company_id,
          run_id: runId,
          pass_no: 1,
          batch_hash: hash1,
          matched_count: first.results.length,
          mismatch_count: 0,
          computed_at: new Date().toISOString(),
        },
        {
          company_id: session.company_id,
          run_id: runId,
          pass_no: 2,
          batch_hash: hash2,
          matched_count: hashMatch ? second.results.length : 0,
          mismatch_count: hashMatch ? 0 : second.results.length,
          computed_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'run_id,pass_no' }
    );

    if (!hashMatch) {
      return {
        ok: false,
        error: '두 번의 계산 결과가 일치하지 않습니다. 저장하지 않았습니다.',
        hashMatch: false,
      };
    }

    await persist(supabase, session.company_id!, runId, first, input, hash1);

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_COMPUTED',
      p_target_table: 'payroll_runs',
      p_target_id: runId,
      p_details: {
        employees: first.results.length,
        gross: first.gross_total,
        net: first.net_total,
        batch_hash: hash1,
      },
    });

    revalidatePath('/payroll');
    return {
      ok: true,
      runId,
      employees: first.results.length,
      hashMatch: true,
      warnings: first.results.reduce((s, r) => s + r.warnings.length, 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '계산에 실패했습니다.' };
  }
}

interface LoadedOk {
  value: EngineInput;
  /** Carried out separately so the run can record exactly which rate sets it
   * computed with; the engine itself has no use for a version string. */
  taxVersion: string | null;
  bpjsVersion: string | null;
}
type Loaded = LoadedOk | { error: string };

async function loadEngineInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  run: Record<string, unknown>
): Promise<Loaded> {
  const cutoffStart = run.cutoff_start as string;
  const cutoffEnd = run.cutoff_end as string;
  const period = run.period as string;

  const [empRes, compRes, otRes, bpjsRes, taxRes, policyRes, daysRes, umkRes] = await Promise.all([
    supabase
      .from('employees')
      .select('id, employee_no, full_name, department_id, position_id, base_salary, ptkp_status, umk_region, join_date, resign_date')
      .or(`resign_date.is.null,resign_date.gte.${cutoffStart}`)
      .lte('join_date', cutoffEnd)
      .order('employee_no'),
    supabase.from('pay_components').select('*').eq('active', true).order('sort_order'),
    supabase.from('ot_rate_rules').select('*').lte('effective_from', cutoffEnd).order('from_hour'),
    supabase.from('bpjs_rates').select('*').is('effective_to', null),
    supabase
      .from('tax_tables')
      .select('version, category, lower_bound, upper_bound, rate, effective_from, effective_to')
      .lte('effective_from', cutoffEnd),
    supabase.from('payroll_policies').select('*').maybeSingle(),
    // Only confirmed attendance. An open period would let figures move after
    // payroll read them.
    supabase
      .from('attendance_days')
      .select('employee_id, work_date, ot_minutes, status, is_confirmed')
      .gte('work_date', cutoffStart)
      .lte('work_date', cutoffEnd)
      .eq('is_confirmed', true),
    supabase.from('umk_rates').select('region, amount'),
  ]);

  const taxRows = (taxRes.data ?? []).filter((t) => t.effective_to === null);
  if (taxRows.length === 0) {
    return { error: '적용 중인 PPh 21 세율표가 없습니다. 정책·요율 화면에서 먼저 등록하세요.' };
  }
  const policy = policyRes.data;
  if (!policy) return { error: '급여 정책이 설정되어 있지 않습니다.' };

  const days = daysRes.data ?? [];
  if (days.length === 0) {
    return { error: '마감된 근태가 없습니다. 근태 마감(G1)을 먼저 완료하세요.' };
  }

  const attendance = new Map<string, EngineAttendance>();
  for (const d of days) {
    const id = d.employee_id as string;
    const entry = attendance.get(id) ?? { employee_id: id, work_days: 0, ot_by_bracket: [] };
    if (d.status === 'present' || d.status === 'anomaly') entry.work_days += 1;
    const otHours = (d.ot_minutes as number) / 60;
    if (otHours > 0) {
      // Every day is treated as a weekday bracket for now. Splitting holiday
      // overtime out needs a holiday calendar, which does not exist yet — and
      // guessing would apply the wrong multiplier, so it is the single
      // simplification worth naming here.
      const bucket = entry.ot_by_bracket.find((b) => b.day_type === 'weekday');
      if (bucket) bucket.hours += otHours;
      else entry.ot_by_bracket.push({ day_type: 'weekday', hours: otHours });
    }
    attendance.set(id, entry);
  }

  const mandateRes = await supabase
    .from('deduction_mandates')
    .select('id, employee_id, monthly_amount, lender_id, start_period, end_period, status')
    .eq('status', 'active')
    .lte('start_period', period);

  const lenderRes = await supabase.from('lender_partners').select('id, name');
  const lenderNames = new Map((lenderRes.data ?? []).map((l) => [l.id as string, l.name as string]));

  return {
    taxVersion: (taxRows[0]?.version as string | undefined) ?? null,
    bpjsVersion: ((bpjsRes.data ?? [])[0]?.version as string | undefined) ?? null,
    value: {
      period,
      cutoffStart,
      cutoffEnd,
      employees: (empRes.data ?? []) as EngineInput['employees'],
      components: (compRes.data ?? []) as EngineInput['components'],
      otBrackets: (otRes.data ?? []) as EngineInput['otBrackets'],
      bpjs: (bpjsRes.data ?? []) as EngineInput['bpjs'],
      taxBands: taxRows as EngineInput['taxBands'],
      policy: {
        ot_hour_divisor: Number(policy.ot_hour_divisor),
        rounding_scope: policy.rounding_scope as 'line' | 'total',
        rounding_unit: Number(policy.rounding_unit),
        proration_basis: policy.proration_basis as 'calendar' | 'fixed_30' | 'working_days',
        max_loan_deduction_rate: Number(policy.max_loan_deduction_rate),
      },
      attendance,
      loans: (mandateRes.data ?? [])
        .filter((m) => !m.end_period || (m.end_period as string) >= period)
        .map((m) => ({
          employee_id: m.employee_id as string,
          mandate_id: m.id as string,
          lender_name: lenderNames.get(m.lender_id as string) ?? '대출',
          amount: Number(m.monthly_amount),
        })),
      umkByRegion: new Map(
        (umkRes.data ?? []).map((u) => [u.region as string, Number(u.amount)])
      ),
    },
  };
}

async function persist(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  runId: string,
  output: EngineOutput,
  loaded: LoadedOk,
  hash: string
) {
  const input = loaded.value;
  // Lines cascade from their item, so clearing the items clears everything
  // derived. Safe to re-run: only an unlocked run reaches here.
  await supabase.from('payroll_items').delete().eq('run_id', runId);

  const items = output.results.map((r) => ({
    company_id: companyId,
    run_id: runId,
    employee_id: r.employee_id,
    employee_no: r.employee_no,
    employee_name: r.employee_name,
    department_id: r.department_id,
    position_id: r.position_id,
    base_salary: r.base_salary,
    ptkp_status: r.ptkp_status,
    work_days: r.work_days,
    ot_minutes: r.ot_minutes,
    gross: r.gross,
    taxable_gross: r.taxable_gross,
    bpjs_base: r.bpjs_base,
    deduction_total: r.deduction_total,
    net: r.net,
  }));

  const { data: inserted, error } = await supabase
    .from('payroll_items')
    .insert(items)
    .select('id, employee_id');
  if (error) throw error;

  const itemIdByEmployee = new Map(
    (inserted ?? []).map((i) => [i.employee_id as string, i.id as string])
  );

  const lines = output.results.flatMap((r) =>
    r.lines.map((l) => ({
      company_id: companyId,
      payroll_item_id: itemIdByEmployee.get(r.employee_id)!,
      component_code: l.component_code,
      component_name: l.component_name,
      kind: l.kind,
      quantity: l.quantity,
      rate: l.rate,
      amount: l.amount,
      taxable: l.taxable,
      bpjs_base: l.bpjs_base,
      legal_basis: l.legal_basis,
      sort_order: l.sort_order,
    }))
  );
  for (let i = 0; i < lines.length; i += 500) {
    const { error: lineError } = await supabase.from('payroll_lines').insert(lines.slice(i, i + 500));
    if (lineError) throw lineError;
  }

  const otLines = output.results.flatMap((r) =>
    r.otLines.map((l) => ({
      company_id: companyId,
      payroll_item_id: itemIdByEmployee.get(r.employee_id)!,
      day_type: l.day_type,
      bracket_label: l.bracket_label,
      multiplier: l.multiplier,
      hours: l.hours,
      hourly_rate: l.hourly_rate,
      amount: l.amount,
      legal_basis: l.legal_basis,
    }))
  );
  if (otLines.length > 0) {
    const { error: otError } = await supabase.from('payroll_ot_lines').insert(otLines);
    if (otError) throw otError;
  }

  // The versions and the policy are written onto the run, not left to be
  // looked up later. This is what makes a payslip reproducible after a rate
  // changes.
  const { error: updateError } = await supabase
    .from('payroll_runs')
    .update({
      status: 'g2_passed',
      tax_table_version: loaded.taxVersion,
      bpjs_rate_version: loaded.bpjsVersion,
      umk_amount: input.umkByRegion.size === 1 ? [...input.umkByRegion.values()][0] : null,
      policy_snapshot: input.policy,
      batch_hash: hash,
      employee_count: output.results.length,
      gross_total: output.gross_total,
      deduction_total: output.deduction_total,
      net_total: output.net_total,
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (updateError) throw updateError;
}
