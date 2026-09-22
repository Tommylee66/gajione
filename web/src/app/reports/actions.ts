'use server';

import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  CATEGORIES,
  findReport,
  reportFilename,
  toCsv,
  type ReportDef,
  type ReportRow,
} from '@/lib/reports/catalogue';

const ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];

async function requireRole() {
  const session = await requireSession();
  if (!ROLES.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface ReportParams {
  /** period reports: the run id. */
  runId?: string;
  /** range reports. */
  from?: string;
  to?: string;
  /** annual reports. */
  year?: number;
}

export interface ReportResult {
  ok: boolean;
  error?: string;
  filename?: string;
  csv?: string;
  rowCount?: number;
  /** First rows, for the on-screen preview. */
  preview?: ReportRow[];
  columns?: string[];
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function generateReportAction(
  reportId: string,
  params: ReportParams
): Promise<ReportResult> {
  try {
    await requireRole();
    const def = findReport(reportId);
    if (!def) return { ok: false, error: '알 수 없는 리포트입니다.' };

    // Checked before anything is validated or queried: an unavailable category
    // has no data source, so a date range on it is a question about nothing.
    const category = CATEGORIES.find((c) => c.id === def.category);
    if (category?.unavailable) {
      // Refused rather than returning an empty file: an empty download reads
      // as "nothing happened that month", which is a different claim.
      return { ok: false, error: category.unavailable };
    }

    const supabase = await createClient();
    const label = await validate(supabase, def, params);
    if ('error' in label) return { ok: false, error: label.error };

    const rows = await build(supabase, def, params);
    return {
      ok: true,
      filename: reportFilename(def, label.label),
      csv: toCsv(def, rows),
      rowCount: rows.length,
      preview: rows.slice(0, 50),
      columns: def.columns,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '생성에 실패했습니다.' };
  }
}

async function validate(
  supabase: Supabase,
  def: ReportDef,
  p: ReportParams
): Promise<{ label: string } | { error: string }> {
  if (def.scope === 'period') {
    if (!p.runId) return { error: '차수를 선택하세요.' };
    const { data } = await supabase
      .from('payroll_runs')
      .select('period, run_type, seq')
      .eq('id', p.runId)
      .maybeSingle();
    if (!data) return { error: '차수를 찾을 수 없습니다.' };
    return { label: `${data.period}_${data.run_type}${Number(data.seq) > 1 ? `_${data.seq}` : ''}` };
  }
  if (def.scope === 'range') {
    if (!p.from || !p.to) return { error: '조회 기간을 지정하세요.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to)) {
      return { error: '날짜는 YYYY-MM-DD 형식이어야 합니다.' };
    }
    if (p.to < p.from) return { error: '종료일이 시작일보다 빠릅니다.' };
    // Bounded, because an unbounded range on attendance_days is every punch
    // the company has ever recorded, assembled in memory.
    const days =
      (Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000;
    if (days > 400) return { error: '조회 기간은 최대 400일입니다. 연간 리포트를 사용하세요.' };
    return { label: `${p.from}_${p.to}` };
  }
  const year = Number(p.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: '연도를 선택하세요.' };
  }
  return { label: String(year) };
}

/** Employee identity, joined in once and shared by every report that needs it. */
async function employeeIndex(supabase: Supabase) {
  const [empRes, deptRes, posRes] = await Promise.all([
    supabase
      .from('employees')
      .select('id, employee_no, full_name, department_id, position_id, employment_type, join_date, resign_date, ptkp_status, npwp, base_salary, is_active'),
    supabase.from('departments').select('id, name'),
    supabase.from('positions').select('id, name'),
  ]);
  const depts = new Map((deptRes.data ?? []).map((d) => [d.id as string, d.name as string]));
  const positions = new Map((posRes.data ?? []).map((p) => [p.id as string, p.name as string]));
  const byId = new Map(
    (empRes.data ?? []).map((e) => [
      e.id as string,
      {
        employee_no: e.employee_no as string,
        employee_name: e.full_name as string,
        department: e.department_id ? (depts.get(e.department_id as string) ?? null) : null,
        position: e.position_id ? (positions.get(e.position_id as string) ?? null) : null,
        employment_type: e.employment_type as string,
        join_date: (e.join_date as string | null) ?? null,
        resign_date: (e.resign_date as string | null) ?? null,
        ptkp_status: (e.ptkp_status as string | null) ?? null,
        npwp: (e.npwp as string | null) ?? null,
        base_salary: Number(e.base_salary ?? 0),
        is_active: Boolean(e.is_active),
      },
    ])
  );
  return { byId, list: [...byId.entries()].map(([id, v]) => ({ id, ...v })) };
}

function yearBounds(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31`, periodFrom: `${year}-01`, periodTo: `${year}-12` };
}

async function build(supabase: Supabase, def: ReportDef, p: ReportParams): Promise<ReportRow[]> {
  const emp = await employeeIndex(supabase);

  /** Payroll items for one run, or for every run in a period window. */
  const itemsFor = async (opts: { runId?: string; periodFrom?: string; periodTo?: string }) => {
    let runIds: string[] = [];
    let runsById = new Map<string, { period: string; run_type: string }>();
    if (opts.runId) {
      runIds = [opts.runId];
      const { data } = await supabase
        .from('payroll_runs')
        .select('id, period, run_type')
        .eq('id', opts.runId);
      runsById = new Map(
        (data ?? []).map((r) => [r.id as string, { period: r.period as string, run_type: r.run_type as string }])
      );
    } else {
      const { data } = await supabase
        .from('payroll_runs')
        .select('id, period, run_type')
        .gte('period', opts.periodFrom!)
        .lte('period', opts.periodTo!);
      runIds = (data ?? []).map((r) => r.id as string);
      runsById = new Map(
        (data ?? []).map((r) => [r.id as string, { period: r.period as string, run_type: r.run_type as string }])
      );
    }
    if (runIds.length === 0) return { items: [], runsById };
    const { data: items } = await supabase.from('payroll_items').select('*').in('run_id', runIds);
    return { items: items ?? [], runsById };
  };

  /** Component totals per payroll item, for the tax and BPJS reports. */
  const linesFor = async (itemIds: string[]) => {
    const byItem = new Map<string, Map<string, number>>();
    for (let i = 0; i < itemIds.length; i += 300) {
      const { data } = await supabase
        .from('payroll_lines')
        .select('payroll_item_id, component_code, amount')
        .in('payroll_item_id', itemIds.slice(i, i + 300));
      for (const l of data ?? []) {
        const key = l.payroll_item_id as string;
        const m = byItem.get(key) ?? new Map<string, number>();
        const code = (l.component_code as string | null) ?? 'OTHER';
        m.set(code, (m.get(code) ?? 0) + Number(l.amount));
        byItem.set(key, m);
      }
    }
    return byItem;
  };

  const who = (employeeId: string) => {
    const e = emp.byId.get(employeeId);
    return {
      employee_no: e?.employee_no ?? '—',
      employee_name: e?.employee_name ?? '(알 수 없음)',
      department: e?.department ?? null,
    };
  };

  switch (def.id) {
    case 'payslip_period': {
      const { items } = await itemsFor({ runId: p.runId });
      return items.map((i) => ({
        ...who(i.employee_id as string),
        work_days: Number(i.work_days),
        ot_hours: round2(Number(i.ot_minutes) / 60),
        gross: Number(i.gross),
        deduction_total: Number(i.deduction_total),
        net: Number(i.net),
      }));
    }
    case 'payslip_range': {
      const { items, runsById } = await itemsFor({
        periodFrom: p.from!.slice(0, 7),
        periodTo: p.to!.slice(0, 7),
      });
      return items
        .map((i) => ({
          period: runsById.get(i.run_id as string)?.period ?? '',
          run_type: runsById.get(i.run_id as string)?.run_type ?? '',
          ...who(i.employee_id as string),
          gross: Number(i.gross),
          deduction_total: Number(i.deduction_total),
          net: Number(i.net),
        }))
        .sort((a, b) => a.period.localeCompare(b.period) || a.employee_no.localeCompare(b.employee_no));
    }
    case 'payslip_annual': {
      const b = yearBounds(p.year!);
      const { items } = await itemsFor({ periodFrom: b.periodFrom, periodTo: b.periodTo });
      const agg = new Map<string, { runs: number; gross: number; ded: number; net: number }>();
      for (const i of items) {
        const key = i.employee_id as string;
        const a = agg.get(key) ?? { runs: 0, gross: 0, ded: 0, net: 0 };
        a.runs += 1;
        a.gross += Number(i.gross);
        a.ded += Number(i.deduction_total);
        a.net += Number(i.net);
        agg.set(key, a);
      }
      return [...agg.entries()].map(([id, a]) => ({
        ...who(id),
        runs: a.runs,
        gross_total: a.gross,
        deduction_total: a.ded,
        net_total: a.net,
      }));
    }

    case 'tax_period': {
      const { items } = await itemsFor({ runId: p.runId });
      const lines = await linesFor(items.map((i) => i.id as string));
      return items.map((i) => {
        const e = emp.byId.get(i.employee_id as string);
        return {
          ...who(i.employee_id as string),
          npwp: e?.npwp ?? null,
          ptkp_status: (i.ptkp_status as string | null) ?? e?.ptkp_status ?? null,
          taxable_gross: Number(i.taxable_gross),
          pph21: lines.get(i.id as string)?.get('PPH21') ?? 0,
        };
      });
    }
    case 'tax_range': {
      const { items, runsById } = await itemsFor({
        periodFrom: p.from!.slice(0, 7),
        periodTo: p.to!.slice(0, 7),
      });
      const lines = await linesFor(items.map((i) => i.id as string));
      return items.map((i) => ({
        period: runsById.get(i.run_id as string)?.period ?? '',
        ...who(i.employee_id as string),
        taxable_gross: Number(i.taxable_gross),
        pph21: lines.get(i.id as string)?.get('PPH21') ?? 0,
      }));
    }
    case 'tax_annual': {
      const b = yearBounds(p.year!);
      const { items } = await itemsFor({ periodFrom: b.periodFrom, periodTo: b.periodTo });
      const lines = await linesFor(items.map((i) => i.id as string));
      const agg = new Map<string, { taxable: number; pph: number }>();
      for (const i of items) {
        const key = i.employee_id as string;
        const a = agg.get(key) ?? { taxable: 0, pph: 0 };
        a.taxable += Number(i.taxable_gross);
        a.pph += lines.get(i.id as string)?.get('PPH21') ?? 0;
        agg.set(key, a);
      }
      return [...agg.entries()].map(([id, a]) => ({
        ...who(id),
        npwp: emp.byId.get(id)?.npwp ?? null,
        ptkp_status: emp.byId.get(id)?.ptkp_status ?? null,
        taxable_gross_total: a.taxable,
        pph21_total: a.pph,
      }));
    }

    case 'bpjs_period': {
      const { items } = await itemsFor({ runId: p.runId });
      const lines = await linesFor(items.map((i) => i.id as string));
      const er = await employerRates(supabase, [p.runId!]);
      return items.map((i) => {
        const m = lines.get(i.id as string) ?? new Map<string, number>();
        const base = Number(i.bpjs_base);
        const cost = (prog: string) => employerCost(er, p.runId!, base, prog);
        const employerTotal = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'].reduce(
          (s, prog) => s + cost(prog),
          0
        );
        return {
          ...who(i.employee_id as string),
          bpjs_base: base,
          kesehatan: m.get('BPJS_KESEHATAN') ?? 0,
          jht: m.get('BPJS_JHT') ?? 0,
          jp: m.get('BPJS_JP') ?? 0,
          employee_total: [...m.entries()]
            .filter(([c]) => c.startsWith('BPJS_'))
            .reduce((s, [, v]) => s + v, 0),
          employer_kesehatan: cost('kesehatan'),
          employer_jht: cost('jht'),
          employer_jp: cost('jp'),
          employer_jkk: cost('jkk'),
          employer_jkm: cost('jkm'),
          employer_total: employerTotal,
        };
      });
    }
    case 'bpjs_range': {
      const { items, runsById } = await itemsFor({
        periodFrom: p.from!.slice(0, 7),
        periodTo: p.to!.slice(0, 7),
      });
      const lines = await linesFor(items.map((i) => i.id as string));
      const er = await employerRates(supabase, [...runsById.keys()]);
      return items.map((i) => {
        const m = lines.get(i.id as string) ?? new Map<string, number>();
        const runId = i.run_id as string;
        const base = Number(i.bpjs_base);
        return {
          period: runsById.get(runId)?.period ?? '',
          ...who(i.employee_id as string),
          employee_total: [...m.entries()]
            .filter(([c]) => c.startsWith('BPJS_'))
            .reduce((s, [, v]) => s + v, 0),
          employer_total: ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'].reduce(
            (s, prog) => s + employerCost(er, runId, base, prog),
            0
          ),
        };
      });
    }
    case 'bpjs_annual': {
      const b = yearBounds(p.year!);
      const { items } = await itemsFor({ periodFrom: b.periodFrom, periodTo: b.periodTo });
      const lines = await linesFor(items.map((i) => i.id as string));
      const er = await employerRates(supabase, [
        ...new Set(items.map((i) => i.run_id as string)),
      ]);
      const agg = new Map<
        string,
        { kes: number; jht: number; jp: number; total: number; employer: number }
      >();
      for (const i of items) {
        const key = i.employee_id as string;
        const m = lines.get(i.id as string) ?? new Map<string, number>();
        const a = agg.get(key) ?? { kes: 0, jht: 0, jp: 0, total: 0, employer: 0 };
        a.kes += m.get('BPJS_KESEHATAN') ?? 0;
        a.jht += m.get('BPJS_JHT') ?? 0;
        a.jp += m.get('BPJS_JP') ?? 0;
        a.total += [...m.entries()].filter(([c]) => c.startsWith('BPJS_')).reduce((s, [, v]) => s + v, 0);
        a.employer += ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'].reduce(
          (s, prog) => s + employerCost(er, i.run_id as string, Number(i.bpjs_base), prog),
          0
        );
        agg.set(key, a);
      }
      return [...agg.entries()].map(([id, a]) => ({
        ...who(id),
        kesehatan_total: a.kes,
        jht_total: a.jht,
        jp_total: a.jp,
        employee_total: a.total,
        employer_total: a.employer,
      }));
    }

    case 'hr_period': {
      const { data: run } = await supabase
        .from('payroll_runs')
        .select('cutoff_end')
        .eq('id', p.runId!)
        .maybeSingle();
      const asOf = (run?.cutoff_end as string | undefined) ?? new Date().toISOString().slice(0, 10);
      // As at the cut-off, not as at today: a leaver since then was on the
      // payroll for that run and belongs on its headcount.
      return emp.list
        .filter((e) => (!e.join_date || e.join_date <= asOf) && (!e.resign_date || e.resign_date > asOf))
        .map((e) => ({
          employee_no: e.employee_no,
          employee_name: e.employee_name,
          department: e.department,
          position: e.position,
          employment_type: e.employment_type,
          join_date: e.join_date,
          ptkp_status: e.ptkp_status,
          base_salary: e.base_salary,
        }));
    }
    case 'hr_range': {
      const out: ReportRow[] = [];
      for (const e of emp.list) {
        if (e.join_date && e.join_date >= p.from! && e.join_date <= p.to!) {
          out.push({
            event: '입사',
            event_date: e.join_date,
            employee_no: e.employee_no,
            employee_name: e.employee_name,
            department: e.department,
            employment_type: e.employment_type,
          });
        }
        if (e.resign_date && e.resign_date >= p.from! && e.resign_date <= p.to!) {
          out.push({
            event: '퇴사',
            event_date: e.resign_date,
            employee_no: e.employee_no,
            employee_name: e.employee_name,
            department: e.department,
            employment_type: e.employment_type,
          });
        }
      }
      return out.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
    }
    case 'hr_annual': {
      const rows: ReportRow[] = [];
      for (let m = 1; m <= 12; m++) {
        const month = `${p.year}-${String(m).padStart(2, '0')}`;
        const end = lastDayOf(p.year!, m);
        rows.push({
          month,
          joined: emp.list.filter((e) => e.join_date?.slice(0, 7) === month).length,
          resigned: emp.list.filter((e) => e.resign_date?.slice(0, 7) === month).length,
          headcount_end: emp.list.filter(
            (e) => (!e.join_date || e.join_date <= end) && (!e.resign_date || e.resign_date > end)
          ).length,
        });
      }
      return rows;
    }

    case 'attendance_period': {
      const { data: run } = await supabase
        .from('payroll_runs')
        .select('cutoff_start, cutoff_end')
        .eq('id', p.runId!)
        .maybeSingle();
      if (!run) return [];
      return attendanceRows(
        supabase,
        who,
        run.cutoff_start as string,
        run.cutoff_end as string,
        true
      );
    }
    case 'attendance_range':
      return attendanceRows(supabase, who, p.from!, p.to!, false);
    case 'attendance_annual': {
      const b = yearBounds(p.year!);
      const { data } = await supabase
        .from('attendance_days')
        .select('employee_id, late_minutes, status')
        .gte('work_date', b.from)
        .lte('work_date', b.to);
      const agg = new Map<string, { days: number; late: number; absent: number }>();
      for (const d of data ?? []) {
        const dept = emp.byId.get(d.employee_id as string)?.department ?? '(미배정)';
        const a = agg.get(dept) ?? { days: 0, late: 0, absent: 0 };
        a.days += 1;
        if (Number(d.late_minutes ?? 0) > 0) a.late += 1;
        if (d.status === 'absent') a.absent += 1;
        agg.set(dept, a);
      }
      return [...agg.entries()].map(([department, a]) => ({
        department,
        days: a.days,
        late_days: a.late,
        absent_days: a.absent,
        late_rate_percent: a.days > 0 ? round2((a.late / a.days) * 100) : 0,
      }));
    }

    case 'overtime_period': {
      const { items } = await itemsFor({ runId: p.runId });
      const lines = await linesFor(items.map((i) => i.id as string));
      return items
        .filter((i) => Number(i.ot_minutes) > 0)
        .map((i) => ({
          ...who(i.employee_id as string),
          ot_hours: round2(Number(i.ot_minutes) / 60),
          ot_amount: lines.get(i.id as string)?.get('OT') ?? 0,
        }));
    }
    case 'overtime_range': {
      const { data } = await supabase
        .from('ot_requests')
        .select('employee_id, work_date, planned_minutes, actual_minutes, over_weekly_cap, status')
        .gte('work_date', p.from!)
        .lte('work_date', p.to!)
        .order('work_date');
      return (data ?? []).map((o) => ({
        ...who(o.employee_id as string),
        work_date: o.work_date as string,
        planned_minutes: Number(o.planned_minutes),
        actual_minutes: o.actual_minutes === null ? null : Number(o.actual_minutes),
        over_weekly_cap: o.over_weekly_cap ? 'Y' : 'N',
        status: o.status as string,
      }));
    }
    case 'overtime_annual': {
      const b = yearBounds(p.year!);
      const { items } = await itemsFor({ periodFrom: b.periodFrom, periodTo: b.periodTo });
      const lines = await linesFor(items.map((i) => i.id as string));
      const agg = new Map<string, { minutes: number; amount: number }>();
      for (const i of items) {
        const key = i.employee_id as string;
        const a = agg.get(key) ?? { minutes: 0, amount: 0 };
        a.minutes += Number(i.ot_minutes);
        a.amount += lines.get(i.id as string)?.get('OT') ?? 0;
        agg.set(key, a);
      }
      return [...agg.entries()]
        .filter(([, a]) => a.minutes > 0)
        .map(([id, a]) => ({
          ...who(id),
          ot_hours_total: round2(a.minutes / 60),
          ot_amount_total: a.amount,
        }));
    }

    case 'loan_period': {
      const { data: run } = await supabase
        .from('payroll_runs')
        .select('period')
        .eq('id', p.runId!)
        .maybeSingle();
      if (!run) return [];
      const { data: execs } = await supabase
        .from('deduction_executions')
        .select('mandate_id, installment_no, amount, status')
        .eq('period', run.period as string);
      const mandates = await mandateIndex(supabase);
      return (execs ?? []).map((e) => {
        const m = mandates.get(e.mandate_id as string);
        return {
          ...who(m?.employee_id ?? ''),
          lender: m?.lender ?? null,
          lender_ref_no: m?.lender_ref_no ?? null,
          installment_no: e.installment_no === null ? null : Number(e.installment_no),
          amount: Number(e.amount),
          status: e.status as string,
        };
      });
    }
    case 'loan_range': {
      const { data: lenders } = await supabase.from('lender_partners').select('id, name');
      const lenderNames = new Map((lenders ?? []).map((l) => [l.id as string, l.name as string]));
      const { data } = await supabase
        .from('loan_referrals')
        .select('*')
        .gte('created_at', `${p.from}T00:00:00Z`)
        .lte('created_at', `${p.to}T23:59:59Z`)
        .order('created_at');
      return (data ?? []).map((r) => ({
        ...who(r.employee_id as string),
        lender: lenderNames.get(r.lender_id as string) ?? null,
        product: (r.product_label as string | null) ?? null,
        amount_requested: Number(r.amount_requested),
        months: r.months === null ? null : Number(r.months),
        score_snapshot: r.score_snapshot === null ? null : Number(r.score_snapshot),
        status: r.status as string,
        created_at: String(r.created_at).slice(0, 10),
      }));
    }
    case 'loan_annual': {
      const b = yearBounds(p.year!);
      const mandates = await mandateIndex(supabase);
      const { data: execs } = await supabase
        .from('deduction_executions')
        .select('mandate_id, amount, period')
        .gte('period', b.periodFrom)
        .lte('period', b.periodTo);
      const deducted = new Map<string, number>();
      for (const e of execs ?? []) {
        const key = e.mandate_id as string;
        deducted.set(key, (deducted.get(key) ?? 0) + Number(e.amount));
      }
      const { data: mirrors } = await supabase
        .from('loan_mirrors')
        .select('lender_ref_no, balance, synced_at');
      const mirrorByRef = new Map(
        (mirrors ?? []).map((m) => [m.lender_ref_no as string, m])
      );
      return [...mandates.entries()].map(([id, m]) => {
        const mirror = m.lender_ref_no ? mirrorByRef.get(m.lender_ref_no) : undefined;
        return {
          ...who(m.employee_id),
          lender: m.lender,
          deducted_total: deducted.get(id) ?? 0,
          // From the lender's book, and null when it has not been synced —
          // never a figure of our own dressed up as theirs.
          balance: mirror?.balance === undefined || mirror?.balance === null ? null : Number(mirror.balance),
          synced_at: mirror?.synced_at ? String(mirror.synced_at).slice(0, 10) : null,
        };
      });
    }

    default:
      return [];
  }
}

/**
 * Employer BPJS cost, computed rather than stored.
 *
 * Only the employee's share reaches a payslip, so nothing in payroll_lines
 * carries the employer side — but the filing and the cost report both need it.
 * It is derived from the rate version the run itself recorded, never from
 * whatever is in force today: a run has to keep costing what it cost.
 */
async function employerRates(supabase: Supabase, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, Map<string, number>>();
  const [runRes, rateRes] = await Promise.all([
    supabase.from('payroll_runs').select('id, bpjs_rate_version').in('id', runIds),
    supabase.from('bpjs_rates').select('version, program, employer_rate, wage_cap'),
  ]);
  const byVersion = new Map<string, { program: string; rate: number; cap: number | null }[]>();
  for (const r of rateRes.data ?? []) {
    const v = r.version as string;
    const list = byVersion.get(v) ?? [];
    list.push({
      program: r.program as string,
      rate: Number(r.employer_rate),
      cap: r.wage_cap === null ? null : Number(r.wage_cap),
    });
    byVersion.set(v, list);
  }
  const byRun = new Map<string, Map<string, number>>();
  for (const run of runRes.data ?? []) {
    const version = (run.bpjs_rate_version as string | null) ?? '';
    const rates = byVersion.get(version) ?? [];
    byRun.set(run.id as string, new Map(rates.map((r) => [r.program, r.rate])));
    // The cap belongs with the rate, so it travels in a parallel map keyed the
    // same way; a programme with no cap stores Infinity so the caller can
    // apply Math.min unconditionally.
    byRun.set(
      `${run.id}:caps`,
      new Map(rates.map((r) => [r.program, r.cap === null ? Number.POSITIVE_INFINITY : r.cap]))
    );
  }
  return byRun;
}

function employerCost(
  byRun: Map<string, Map<string, number>>,
  runId: string,
  bpjsBase: number,
  program: string
): number {
  const rate = byRun.get(runId)?.get(program) ?? 0;
  if (rate <= 0) return 0;
  const cap = byRun.get(`${runId}:caps`)?.get(program) ?? Number.POSITIVE_INFINITY;
  return Math.round(Math.min(bpjsBase, cap) * rate);
}

async function mandateIndex(supabase: Supabase) {
  const [mandateRes, lenderRes] = await Promise.all([
    supabase.from('deduction_mandates').select('id, employee_id, lender_id, lender_ref_no'),
    supabase.from('lender_partners').select('id, name'),
  ]);
  const lenders = new Map((lenderRes.data ?? []).map((l) => [l.id as string, l.name as string]));
  return new Map(
    (mandateRes.data ?? []).map((m) => [
      m.id as string,
      {
        employee_id: m.employee_id as string,
        lender: lenders.get(m.lender_id as string) ?? null,
        lender_ref_no: (m.lender_ref_no as string | null) ?? null,
      },
    ])
  );
}

async function attendanceRows(
  supabase: Supabase,
  who: (id: string) => { employee_no: string; employee_name: string; department: string | null },
  from: string,
  to: string,
  detailed: boolean
): Promise<ReportRow[]> {
  const { data } = await supabase
    .from('attendance_days')
    .select('employee_id, work_date, check_in, check_out, late_minutes, ot_minutes, status')
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date');
  return (data ?? []).map((d) => {
    const base = {
      ...who(d.employee_id as string),
      work_date: d.work_date as string,
      late_minutes: Number(d.late_minutes ?? 0),
      ot_minutes: Number(d.ot_minutes ?? 0),
      status: d.status as string,
    };
    if (!detailed) return base;
    return {
      ...base,
      check_in: d.check_in ? String(d.check_in).slice(11, 16) : null,
      check_out: d.check_out ? String(d.check_out).slice(11, 16) : null,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lastDayOf(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}
