/**
 * What the payroll home screen derives from a run.
 *
 * Pure, because every figure here is a claim about where the month stands —
 * "G3, 2 of 4 gates, 58%" — and a claim nobody can recompute is one nobody can
 * check. The screen reads these; it decides nothing itself.
 */

export type RunStatus =
  | 'draft'
  | 'g1_passed'
  | 'g2_passed'
  | 'g3_passed'
  | 'approved'
  | 'locked'
  | 'cancelled';

export interface RunSummary {
  id: string;
  period: string;
  run_type: string;
  seq: number;
  status: RunStatus;
  cutoff_start: string;
  cutoff_end: string;
  pay_date: string;
  employee_count: number;
  gross_total: number;
  deduction_total: number;
  net_total: number;
  locked_at: string | null;
  batch_hash: string | null;
  tax_table_version: string | null;
}

export const RUN_TYPE_LABELS: Record<string, string> = {
  regular: '정기급여',
  thr: 'THR (종교휴일수당)',
  bonus: '상여금',
  resignation: '퇴직정산',
  correction: '정정',
};

export const STATUS_LABELS: Record<string, string> = {
  draft: '작성중',
  g1_passed: 'G1 통과',
  g2_passed: 'G2 통과',
  g3_passed: 'G3 통과',
  approved: '승인완료',
  locked: '마감',
  cancelled: '취소',
};

/**
 * Days from today to the pay date. Compared as calendar dates in the company's
 * own day, not as instants: a run that pays tomorrow is D-1 for everyone in the
 * office regardless of what hour it is.
 */
export function daysUntil(payDate: string, today: string): number {
  const a = Date.UTC(
    Number(payDate.slice(0, 4)),
    Number(payDate.slice(5, 7)) - 1,
    Number(payDate.slice(8, 10))
  );
  const b = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10))
  );
  return Math.round((a - b) / 86_400_000);
}

export function dDayLabel(payDate: string, today: string): string {
  const d = daysUntil(payDate, today);
  if (d === 0) return '지급일';
  return d > 0 ? `D-${d}` : `D+${-d}`;
}

const ORDER: RunStatus[] = ['draft', 'g1_passed', 'g2_passed', 'g3_passed', 'approved', 'locked'];

/** How far a status has advanced. Cancelled is outside the ladder, not at the end of it. */
function rank(status: RunStatus): number {
  const i = ORDER.indexOf(status);
  return i < 0 ? -1 : i;
}

export interface GateStage {
  code: 'G1' | 'G2' | 'G3' | 'G4';
  name: string;
  state: 'passed' | 'active' | 'locked';
  detail: string;
}

export interface PipelineContext {
  openAnomalies: number;
  pendingOt: number;
  batchHash: string | null;
  taxVersion: string | null;
  recalcsAgree: boolean;
  rulesPassed: number;
  rulesTotal: number;
  openVariances: number;
  signedSteps: number;
  totalSteps: number;
  hasPaymentFile: boolean;
}

/**
 * The four gates as the run currently stands.
 *
 * A gate is 'active' only when it is the one the run is sitting at — every
 * later gate reads 'locked' rather than 'failed'. A gate that has not been
 * reached has not failed, and colouring it as a failure sends people to fix
 * something that was never broken.
 */
export function pipeline(status: RunStatus, ctx: PipelineContext): GateStage[] {
  const r = rank(status);
  const stageState = (needed: number): 'passed' | 'active' | 'locked' =>
    r >= needed ? 'passed' : r === needed - 1 ? 'active' : 'locked';

  return [
    {
      code: 'G1',
      name: '근태무결성',
      state: stageState(1),
      detail:
        r >= 1
          ? '근태 확정'
          : `이상근태 ${ctx.openAnomalies}건 · OT 승인대기 ${ctx.pendingOt}건`,
    },
    {
      code: 'G2',
      name: '계산정합성',
      state: stageState(2),
      detail:
        r >= 2
          ? `재계산 일치 · ${ctx.taxVersion ?? '요율 미기록'}`
          : ctx.batchHash
            ? ctx.recalcsAgree
              ? '재계산 일치 — 통과 처리 대기'
              : '두 번의 계산이 불일치'
            : '아직 계산되지 않았습니다',
    },
    {
      code: 'G3',
      name: '검증·소명',
      state: stageState(3),
      detail:
        r >= 3
          ? '규칙·소명 완료'
          : ctx.rulesTotal > 0
            ? `규칙 ${ctx.rulesPassed}/${ctx.rulesTotal} 통과 · 소명 대기 ${ctx.openVariances}건`
            : '아직 평가하지 않았습니다',
    },
    {
      code: 'G4',
      name: '승인·지급',
      state: r >= 4 ? 'passed' : r === 3 ? 'active' : 'locked',
      detail:
        status === 'locked'
          ? '마감 완료'
          : ctx.totalSteps > 0
            ? `결재 ${ctx.signedSteps}/${ctx.totalSteps}${ctx.hasPaymentFile ? ' · 이체파일 생성됨' : ''}`
            : 'G3 통과 후 결재 상신',
    },
  ];
}

/** Gates cleared out of four, and the same as a percentage for the progress bar. */
export function gateProgress(status: RunStatus): { cleared: number; percent: number } {
  const cleared = Math.max(0, Math.min(4, rank(status)));
  return { cleared, percent: Math.round((cleared / 4) * 100) };
}

export interface DecisionItem {
  /** Sorted by this: what stops the run outranks what merely needs attention. */
  weight: number;
  tag: string;
  title: string;
  basis: string;
  href: string;
  linkLabel: string;
}

export interface DecisionContext extends PipelineContext {
  runId: string;
  status: RunStatus;
  /** Employees with no bank account on file — each one blocks the transfer file. */
  missingAccounts: number;
  nextApprovalRole: string | null;
}

/**
 * The queue is derived, never stored. Anything on it is something the run is
 * actually waiting on right now, so an item that disappears has been dealt
 * with rather than dismissed.
 */
export function decisionQueue(ctx: DecisionContext): DecisionItem[] {
  const out: DecisionItem[] = [];
  const r = rank(ctx.status);

  if (ctx.openVariances > 0 && r < 3) {
    out.push({
      weight: 10,
      tag: '검증/대기',
      title: `급여변동 소명 ${ctx.openVariances}건`,
      basis: 'G3가 열려 있어 승인·지급으로 넘어갈 수 없습니다',
      href: `/payroll/${ctx.runId}`,
      linkLabel: '품질게이트로 이동',
    });
  }
  if (ctx.openAnomalies > 0 && r < 1) {
    out.push({
      weight: 9,
      tag: '근태/대기',
      title: `이상근태 ${ctx.openAnomalies}건`,
      basis: 'G1 확정 전까지 계산을 시작할 수 없습니다',
      href: '/attendance',
      linkLabel: '근태로 이동',
    });
  }
  // Gated on G1 the same way anomalies are: once the run's attendance is
  // fixed, an outstanding OT request belongs to a later run, not this one.
  if (ctx.pendingOt > 0 && r < 1) {
    out.push({
      weight: 8,
      tag: 'OT/대기',
      title: `OT 사전승인 ${ctx.pendingOt}건`,
      basis: '승인되지 않은 OT는 계산에 반영되지 않습니다',
      href: '/overtime',
      linkLabel: 'OT 승인으로 이동',
    });
  }
  if (r === 3 && ctx.nextApprovalRole) {
    out.push({
      weight: 10,
      tag: '지급/대기',
      title: `${ctx.nextApprovalRole} 서명 대기`,
      basis: '위임은 허용되지 않아 해당 권한자만 서명할 수 있습니다',
      href: `/payroll/${ctx.runId}`,
      linkLabel: '승인·지급으로 이동',
    });
  }
  if (r === 3 && ctx.totalSteps === 0) {
    out.push({
      weight: 10,
      tag: '지급/신규',
      title: '결재 상신',
      basis: 'G3를 통과했습니다. 결재선을 시작할 수 있습니다',
      href: `/payroll/${ctx.runId}`,
      linkLabel: '승인·지급으로 이동',
    });
  }
  // Surfaced early rather than at file generation: a missing account is a
  // week's worth of chasing the employee, not a minute's fix at the end.
  if (ctx.missingAccounts > 0 && !ctx.hasPaymentFile) {
    out.push({
      weight: 7,
      tag: '지급/준비',
      title: `계좌 미등록 ${ctx.missingAccounts}명`,
      basis: '한 명이라도 계좌가 없으면 이체파일이 생성되지 않습니다',
      href: '/employees',
      linkLabel: '직원 마스터로 이동',
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

export interface Bucket {
  label: string;
  amount: number;
}

/**
 * Pay composition, grouped the way the payslip reads rather than by component
 * code. Anything unrecognised lands in 기타 instead of being dropped, so the
 * buckets always add up to the run's own totals.
 */
export function composition(
  lines: { component_code: string | null; kind: string; amount: number }[]
): { earnings: Bucket[]; deductions: Bucket[] } {
  const e = new Map<string, number>();
  const d = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const l of lines) {
    const code = l.component_code ?? '';
    const amount = Number(l.amount);
    if (l.kind === 'earning') {
      if (code === 'BASE') add(e, '기본급', amount);
      else if (code === 'OT') add(e, '초과근무', amount);
      else add(e, '수당', amount);
    } else {
      if (code === 'PPH21') add(d, 'PPh 21', amount);
      else if (code.startsWith('BPJS_')) add(d, 'BPJS', amount);
      else if (code === 'LOAN') add(d, '대출 공제', amount);
      else add(d, '기타 공제', amount);
    }
  }

  const toList = (m: Map<string, number>) =>
    [...m.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
  return { earnings: toList(e), deductions: toList(d) };
}

export function byDepartment(
  items: { department_id: string | null; net: number }[],
  names: Map<string, string>
): Bucket[] {
  const m = new Map<string, number>();
  for (const i of items) {
    const label = i.department_id ? (names.get(i.department_id) ?? '(알 수 없음)') : '(미배정)';
    m.set(label, (m.get(label) ?? 0) + Number(i.net));
  }
  return [...m.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export interface Delta {
  label: string;
  current: string;
  changePercent: number | null;
}

/** Month-on-month. Null rather than 0% when there is nothing to compare against. */
export function delta(label: string, current: number, previous: number | null, format: (n: number) => string): Delta {
  return {
    label,
    current: format(current),
    changePercent: previous && previous !== 0 ? ((current - previous) / previous) * 100 : null,
  };
}

const AUDIT_LABELS: Record<string, string> = {
  PAYROLL_G3_EVALUATED: 'G3 규칙 평가',
  PAYROLL_G3_PASSED: 'G3 통과',
  PAYROLL_VARIANCE_DECIDED: '변동 소명 판단',
  PAYROLL_APPROVAL_SIGNED: '결재 서명',
  PAYMENT_FILE_GENERATED: '이체파일 생성',
  PAYSLIPS_QUEUED: '명세서 배포 등록',
  PAYROLL_RUN_LOCKED: '차수 마감',
  PAYROLL_COMPUTED: '급여 계산',
  ATTENDANCE_IMPORTED: '근태 업로드',
};

export function auditLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action;
}
