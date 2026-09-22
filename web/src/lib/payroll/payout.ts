/**
 * G4: what leaves the system once payroll is approved.
 *
 * Pure, so the payment file can be rebuilt from the same run and compared —
 * which is the only way to answer "is the file the bank received the one we
 * generated" after the fact.
 */

export interface PayoutRow {
  employee_no: string;
  employee_name: string;
  bank_name: string;
  account_number: string;
  amount: number;
}

export interface PaymentFile {
  content: string;
  totalAmount: number;
  recordCount: number;
  hash: string;
}

export interface PayoutCandidate {
  employee_id: string;
  employee_no: string;
  employee_name: string;
  net: number;
  bank_name: string | null;
  account_number: string | null;
}

export interface PayoutBuild {
  file: PaymentFile | null;
  /** Employees who cannot be paid, with the reason. Blocking: a transfer file
   * that silently omits people pays nobody's rent. */
  blocked: { employee_no: string; employee_name: string; reason: string }[];
}

/**
 * Bank host-to-host format, as a CSV the bank's template maps onto.
 *
 * Deliberately plain: the real integration differs per bank and per contract,
 * and inventing a proprietary layout here would have to be thrown away. What
 * matters now is that the figures, the count and the hash are right, and that
 * the file is reproducible.
 */
export function buildPaymentFile(
  candidates: PayoutCandidate[],
  meta: { period: string; payDate: string; companyName: string }
): PayoutBuild {
  const blocked: PayoutBuild['blocked'] = [];
  const rows: PayoutRow[] = [];

  for (const c of candidates) {
    if (c.net <= 0) {
      blocked.push({
        employee_no: c.employee_no,
        employee_name: c.employee_name,
        reason: '실지급액이 0 이하입니다.',
      });
      continue;
    }
    if (!c.account_number || !c.bank_name) {
      blocked.push({
        employee_no: c.employee_no,
        employee_name: c.employee_name,
        reason: '등록된 계좌가 없습니다.',
      });
      continue;
    }
    rows.push({
      employee_no: c.employee_no,
      employee_name: c.employee_name,
      bank_name: c.bank_name,
      account_number: c.account_number,
      amount: Math.round(c.net),
    });
  }

  if (blocked.length > 0) return { file: null, blocked };
  if (rows.length === 0) return { file: null, blocked };

  // Sorted by employee number so the same run always produces byte-identical
  // output, which is what makes the hash meaningful.
  rows.sort((a, b) => a.employee_no.localeCompare(b.employee_no));

  const header = `# ${meta.companyName} · ${meta.period} · 지급일 ${meta.payDate}`;
  const columns = 'employee_no,employee_name,bank_name,account_number,amount';
  const body = rows
    .map((r) =>
      [
        r.employee_no,
        `"${r.employee_name.replace(/"/g, '""')}"`,
        r.bank_name,
        r.account_number,
        r.amount,
      ].join(',')
    )
    .join('\n');
  const content = `${header}\n${columns}\n${body}\n`;

  return {
    file: {
      content,
      totalAmount: rows.reduce((s, r) => s + r.amount, 0),
      recordCount: rows.length,
      hash: fnv1a(content),
    },
    blocked: [],
  };
}

export interface FilingTotals {
  pph21: number;
  bpjsEmployee: number;
  headcount: number;
}

/**
 * Totals for the statutory filings that follow payment. Kept from the run
 * rather than recomputed at filing time, so what was filed and what was paid
 * can be compared later.
 */
export function buildFilingTotals(
  lines: { component_code: string | null; amount: number; payroll_item_id: string }[]
): FilingTotals {
  let pph21 = 0;
  let bpjsEmployee = 0;
  const items = new Set<string>();
  for (const l of lines) {
    items.add(l.payroll_item_id);
    if (l.component_code === 'PPH21') pph21 += l.amount;
    else if (l.component_code?.startsWith('BPJS_')) bpjsEmployee += l.amount;
  }
  return { pph21, bpjsEmployee, headcount: items.size };
}

/**
 * The approval chain. Order is the control: the mockup states delegation is
 * not permitted, so the steps are fixed and each has a named role.
 */
export const APPROVAL_STEPS = [
  { step_no: 1, role_label: '급여담당' },
  { step_no: 2, role_label: 'HR장' },
  { step_no: 3, role_label: '법인장' },
] as const;

export interface ApprovalRow {
  step_no: number;
  role_label: string;
  approver_id: string | null;
  signed_at: string | null;
  status: string;
}

/** Which step may be signed next, or null when the chain is complete. */
export function nextSignableStep(approvals: ApprovalRow[]): number | null {
  const sorted = [...approvals].sort((a, b) => a.step_no - b.step_no);
  for (const a of sorted) {
    if (a.status !== 'approved') return a.step_no;
  }
  return null;
}

export function chainComplete(approvals: ApprovalRow[]): boolean {
  return approvals.length > 0 && approvals.every((a) => a.status === 'approved');
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let g = 0x811c9dc5;
  for (let i = text.length - 1; i >= 0; i--) {
    g ^= text.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0');
}
