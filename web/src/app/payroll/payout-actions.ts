'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { decryptAccount, type EncryptedPayload } from '@/lib/crypto/account-encryption';
import {
  APPROVAL_STEPS,
  buildPaymentFile,
  buildFilingTotals,
  chainComplete,
  nextSignableStep,
  type ApprovalRow,
  type PayoutCandidate,
} from '@/lib/payroll/payout';

const RUN_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];
const SIGN_ROLES = ['hr_admin', 'payroll_staff', 'operator_admin'];

async function requireRole(roles: string[]) {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface PayoutResult {
  ok: boolean;
  error?: string;
  blocked?: { employee_no: string; employee_name: string; reason: string }[];
  recordCount?: number;
  totalAmount?: number;
  distributed?: number;
}

export async function initApprovalsAction(runId: string): Promise<PayoutResult> {
  try {
    const session = await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: run } = await supabase
      .from('payroll_runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle();
    if (!run) return { ok: false, error: '차수를 찾을 수 없습니다.' };
    if (run.status !== 'g3_passed') {
      return { ok: false, error: 'G3를 통과한 차수만 결재를 시작할 수 있습니다.' };
    }

    const { data: existing } = await supabase
      .from('approvals')
      .select('id')
      .eq('run_id', runId)
      .limit(1);
    if ((existing ?? []).length > 0) return { ok: false, error: '이미 결재가 시작되었습니다.' };

    const { error } = await supabase.from('approvals').insert(
      APPROVAL_STEPS.map((s) => ({
        company_id: session.company_id,
        run_id: runId,
        step_no: s.step_no,
        role_label: s.role_label,
        status: 'pending',
      }))
    );
    if (error) throw error;

    revalidatePath(`/payroll/${runId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * Signs one step of the chain.
 *
 * Order is enforced here, not assumed: signing step 3 while step 2 is
 * outstanding is refused. The mockup states delegation is not permitted, so
 * the same person signing two different steps is refused as well — a chain
 * where one account holds every signature is a single approval wearing three
 * hats.
 */
export async function signApprovalAction(
  runId: string,
  stepNo: number
): Promise<PayoutResult> {
  try {
    const session = await requireRole(SIGN_ROLES);
    const supabase = await createClient();

    const { data: approvals } = await supabase
      .from('approvals')
      .select('step_no, role_label, approver_id, signed_at, status')
      .eq('run_id', runId)
      .order('step_no');
    const rows = (approvals ?? []) as ApprovalRow[];
    if (rows.length === 0) return { ok: false, error: '결재선이 없습니다.' };

    const next = nextSignableStep(rows);
    if (next === null) return { ok: false, error: '이미 결재가 완료되었습니다.' };
    if (next !== stepNo) {
      const pending = rows.find((r) => r.step_no === next);
      return {
        ok: false,
        error: `순서상 ${pending?.role_label} 결재가 먼저입니다. 위임은 허용되지 않습니다.`,
      };
    }

    if (rows.some((r) => r.approver_id === session.id && r.status === 'approved')) {
      return { ok: false, error: '한 사람이 두 단계를 서명할 수 없습니다.' };
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('approvals')
      .update({
        approver_id: session.id,
        signed_at: now,
        // The signature record is the user, the step and the moment. A real
        // certified e-signature (PSrE) would replace this reference; the
        // column exists so that swap does not change the schema.
        signature_ref: `user:${session.id}|step:${stepNo}|at:${now}`,
        status: 'approved',
        updated_at: now,
      })
      .eq('run_id', runId)
      .eq('step_no', stepNo);
    if (error) throw error;

    const updated = rows.map((r) =>
      r.step_no === stepNo ? { ...r, status: 'approved', approver_id: session.id } : r
    );
    if (chainComplete(updated)) {
      await supabase
        .from('payroll_runs')
        .update({ status: 'approved', updated_at: now })
        .eq('id', runId);
    }

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_APPROVAL_SIGNED',
      p_target_table: 'approvals',
      p_target_id: `${runId}|${stepNo}`,
      p_details: { step_no: stepNo, role_label: rows.find((r) => r.step_no === stepNo)?.role_label },
    });

    revalidatePath(`/payroll/${runId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '서명에 실패했습니다.' };
  }
}

/**
 * Builds the bank transfer file.
 *
 * Refuses outright if anyone cannot be paid — a missing account or a
 * non-positive net. A file that silently omits people looks successful and
 * leaves somebody unpaid until they notice.
 */
export async function generatePaymentFileAction(runId: string): Promise<PayoutResult> {
  try {
    const session = await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: run } = await supabase.from('payroll_runs').select('*').eq('id', runId).maybeSingle();
    if (!run) return { ok: false, error: '차수를 찾을 수 없습니다.' };
    if (run.status !== 'approved' && run.status !== 'locked') {
      return { ok: false, error: '결재가 완료된 차수만 이체파일을 만들 수 있습니다.' };
    }

    const [itemRes, accountRes, companyRes] = await Promise.all([
      supabase.from('payroll_items').select('employee_id, employee_no, employee_name, net').eq('run_id', runId),
      supabase
        .from('employee_bank_accounts')
        .select('employee_id, bank_name, account_number_encrypted')
        .eq('is_primary', true),
      supabase.from('companies').select('name').maybeSingle(),
    ]);

    const accounts = new Map<string, { bank: string; encrypted: EncryptedPayload | null }>();
    for (const a of accountRes.data ?? []) {
      accounts.set(a.employee_id as string, {
        bank: a.bank_name as string,
        encrypted: (a.account_number_encrypted as EncryptedPayload | null) ?? null,
      });
    }

    const candidates: PayoutCandidate[] = (itemRes.data ?? []).map((i) => {
      const acct = accounts.get(i.employee_id as string);
      let accountNumber: string | null = null;
      if (acct?.encrypted) {
        try {
          accountNumber = decryptAccount(acct.encrypted);
        } catch {
          // A key mismatch reads as a missing account rather than crashing the
          // whole file — the blocked list then names exactly who to look at.
          accountNumber = null;
        }
      }
      return {
        employee_id: i.employee_id as string,
        employee_no: i.employee_no as string,
        employee_name: i.employee_name as string,
        net: Number(i.net),
        bank_name: acct?.bank ?? null,
        account_number: accountNumber,
      };
    });

    const built = buildPaymentFile(candidates, {
      period: run.period as string,
      payDate: run.pay_date as string,
      companyName: companyRes.data?.name ?? '',
    });

    if (!built.file) {
      return {
        ok: false,
        error: '지급할 수 없는 직원이 있어 이체파일을 만들지 않았습니다.',
        blocked: built.blocked,
      };
    }

    // The file content itself is not stored — it carries every account number
    // in the company in plaintext. What is kept is the hash, the total and the
    // count, which is what a reconciliation needs.
    const { error } = await supabase.from('payment_files').insert({
      company_id: session.company_id,
      run_id: runId,
      bank_code: 'H2H',
      format: 'h2h',
      file_hash: built.file.hash,
      total_amount: built.file.totalAmount,
      record_count: built.file.recordCount,
      status: 'generated',
    });
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAYMENT_FILE_GENERATED',
      p_target_table: 'payment_files',
      p_target_id: runId,
      p_details: {
        records: built.file.recordCount,
        total: built.file.totalAmount,
        hash: built.file.hash,
      },
    });

    revalidatePath(`/payroll/${runId}`);
    return {
      ok: true,
      recordCount: built.file.recordCount,
      totalAmount: built.file.totalAmount,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '생성에 실패했습니다.' };
  }
}

export async function distributePayslipsAction(
  runId: string,
  channel: 'whatsapp' | 'email'
): Promise<PayoutResult> {
  try {
    const session = await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: items } = await supabase
      .from('payroll_items')
      .select('id, employee_id')
      .eq('run_id', runId);
    if ((items ?? []).length === 0) return { ok: false, error: '계산 결과가 없습니다.' };

    const { data: existing } = await supabase
      .from('payslips')
      .select('payroll_item_id')
      .eq('channel', channel)
      .in('payroll_item_id', (items ?? []).map((i) => i.id as string));
    const already = new Set((existing ?? []).map((e) => e.payroll_item_id as string));

    const rows = (items ?? [])
      .filter((i) => !already.has(i.id as string))
      .map((i) => ({
        company_id: session.company_id,
        payroll_item_id: i.id as string,
        employee_id: i.employee_id as string,
        channel,
        // Recorded as queued, not sent. The actual send is an external
        // integration; marking it sent here would make the 열람률 figure a
        // fiction built on a send that never happened.
        status: 'pending',
      }));

    if (rows.length === 0) return { ok: false, error: '이미 모두 등록되어 있습니다.' };

    const { error } = await supabase.from('payslips').insert(rows);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAYSLIPS_QUEUED',
      p_target_table: 'payslips',
      p_target_id: runId,
      p_details: { channel, count: rows.length },
    });

    revalidatePath(`/payroll/${runId}`);
    return { ok: true, distributed: rows.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

export async function generateFilingsAction(runId: string): Promise<PayoutResult> {
  try {
    const session = await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: run } = await supabase
      .from('payroll_runs')
      .select('period, status')
      .eq('id', runId)
      .maybeSingle();
    if (!run) return { ok: false, error: '차수를 찾을 수 없습니다.' };

    const { data: items } = await supabase.from('payroll_items').select('id').eq('run_id', runId);
    const itemIds = (items ?? []).map((i) => i.id as string);
    if (itemIds.length === 0) return { ok: false, error: '계산 결과가 없습니다.' };

    const { data: lines } = await supabase
      .from('payroll_lines')
      .select('component_code, amount, payroll_item_id')
      .in('payroll_item_id', itemIds);

    const totals = buildFilingTotals(
      (lines ?? []).map((l) => ({
        component_code: (l.component_code as string | null) ?? null,
        amount: Number(l.amount),
        payroll_item_id: l.payroll_item_id as string,
      }))
    );

    await supabase.from('tax_filings').delete().eq('run_id', runId).eq('status', 'draft');
    const { error } = await supabase.from('tax_filings').insert([
      {
        company_id: session.company_id,
        run_id: runId,
        kind: 'ebupot_pph21',
        period: run.period as string,
        total_amount: totals.pph21,
        status: 'draft',
      },
      {
        company_id: session.company_id,
        run_id: runId,
        kind: 'sipp_bpjs',
        period: run.period as string,
        total_amount: totals.bpjsEmployee,
        status: 'draft',
      },
    ]);
    if (error) throw error;

    revalidatePath(`/payroll/${runId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '생성에 실패했습니다.' };
  }
}

/** Closes the run. Nothing about it moves afterwards. */
export async function lockRunAction(runId: string): Promise<PayoutResult> {
  try {
    await requireRole(RUN_ROLES);
    const supabase = await createClient();

    const { data: file } = await supabase
      .from('payment_files')
      .select('id')
      .eq('run_id', runId)
      .limit(1);
    if ((file ?? []).length === 0) {
      return { ok: false, error: '이체파일이 생성되지 않았습니다.' };
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('payroll_runs')
      .update({ status: 'locked', locked_at: now, updated_at: now })
      .eq('id', runId);
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'PAYROLL_RUN_LOCKED',
      p_target_table: 'payroll_runs',
      p_target_id: runId,
      p_details: {},
    });

    revalidatePath(`/payroll/${runId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '마감에 실패했습니다.' };
  }
}
