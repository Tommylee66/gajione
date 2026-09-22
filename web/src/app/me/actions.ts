'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';

/**
 * What a worker does about their own record.
 *
 * Two of these replace things the rest of the system had somebody else doing
 * on their behalf: opening a payslip, and answering a loan offer. Both are
 * only worth recording if it is the person themselves, which is why they live
 * here rather than as another button on an HR screen.
 */
async function requireEmployee() {
  const session = await requireSession();
  if (!session.employee_id) {
    throw new Error('직원 계정이 아닙니다. 인사 담당자에게 문의하세요.');
  }
  return session;
}

export interface MeResult {
  ok: boolean;
  error?: string;
}

/**
 * Marks a payslip as opened.
 *
 * The first open only. A second visit is not a second delivery, and letting
 * opened_at move would turn "when did they see it" into "when did they last
 * look" — which is not what a dispute about delivery asks.
 */
export async function markPayslipOpenedAction(payrollItemId: string): Promise<MeResult> {
  try {
    const session = await requireEmployee();
    const supabase = await createClient();

    const { data: slips } = await supabase
      .from('payslips')
      .select('id, opened_at, status')
      .eq('payroll_item_id', payrollItemId)
      .eq('employee_id', session.employee_id);

    const unopened = (slips ?? []).filter((s) => !s.opened_at);
    if (unopened.length === 0) return { ok: true };

    const now = new Date().toISOString();
    for (const s of unopened) {
      await supabase
        .from('payslips')
        .update({ opened_at: now, status: 'opened', updated_at: now })
        .eq('id', s.id as string);
    }

    revalidatePath('/me/payslip');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * The worker's own answer to a loan offer.
 *
 * The same checks as the HR relay — expiry, and the deduction ceiling against
 * the instalment the offer actually carries — because they are properties of
 * the offer, not of who is clicking. What differs is responded_by, which is
 * the point: a deduction the borrower agreed to, with their own name on the
 * agreement.
 */
export async function respondToMyOfferAction(
  offerId: string,
  response: 'accepted' | 'declined',
  reason: string
): Promise<MeResult> {
  try {
    const session = await requireEmployee();
    const supabase = await createClient();

    const { data: offer } = await supabase
      .from('loan_offers')
      .select('*')
      .eq('id', offerId)
      .maybeSingle();
    // RLS scopes this to their own offers, so a missing row is somebody else's.
    if (!offer) return { ok: false, error: '오퍼를 찾을 수 없습니다.' };
    if (offer.status !== 'sent') {
      return { ok: false, error: '응답할 수 있는 상태가 아닙니다.' };
    }
    if (Date.parse(offer.expires_at as string) <= Date.now()) {
      return { ok: false, error: '유효기간이 지난 오퍼입니다. 인사팀에 재발송을 요청하세요.' };
    }

    if (response === 'accepted') {
      const [policyRes, itemRes, mandateRes] = await Promise.all([
        supabase.from('payroll_policies').select('max_loan_deduction_rate').maybeSingle(),
        supabase
          .from('payroll_items')
          .select('net')
          .eq('employee_id', session.employee_id)
          .order('created_at', { ascending: false })
          .limit(3),
        supabase
          .from('deduction_mandates')
          .select('monthly_amount')
          .eq('employee_id', session.employee_id)
          .eq('status', 'active'),
      ]);
      const nets = (itemRes.data ?? []).map((i) => Number(i.net));
      const monthlyNet = nets.length > 0 ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
      const committed = (mandateRes.data ?? []).reduce((s, m) => s + Number(m.monthly_amount), 0);
      const maxRate = Number(policyRes.data?.max_loan_deduction_rate ?? 30);
      const available = Math.max(0, Math.floor((monthlyNet * maxRate) / 100) - committed);
      const instalment = Number(offer.first_month_amount ?? offer.monthly_amount);
      if (monthlyNet > 0 && instalment > available) {
        return {
          ok: false,
          error: `월 상환액 ${instalment.toLocaleString('id-ID')}이 급여공제 한도 ${available.toLocaleString('id-ID')}을 넘습니다. 조건 변경을 요청하세요.`,
        };
      }
    }

    const now = new Date().toISOString();
    const { data: touched, error } = await supabase
      .from('loan_offers')
      .update({
        status: response,
        responded_at: now,
        responded_by: session.id,
        decline_reason: response === 'declined' ? reason : null,
        updated_at: now,
      })
      .eq('id', offerId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '응답할 권한이 없습니다.' };

    if (response === 'declined') {
      await supabase
        .from('loan_referrals')
        .update({ status: 'cancelled', updated_at: now })
        .eq('id', offer.referral_id as string);
    }

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_OFFER_ANSWERED_BY_EMPLOYEE',
      p_target_table: 'loan_offers',
      p_target_id: offerId,
      p_details: { response, reason: reason || null },
    });

    revalidatePath('/me/credit');
    revalidatePath('/loans');
    revalidatePath('/partner');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/** A leave request. Approval belongs to the line manager and is not granted here. */
export async function requestLeaveAction(input: {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
}): Promise<MeResult> {
  try {
    const session = await requireEmployee();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
      return { ok: false, error: '날짜 형식이 올바르지 않습니다.' };
    }
    if (input.endDate < input.startDate) {
      return { ok: false, error: '종료일이 시작일보다 빠릅니다.' };
    }
    if (!(input.days > 0)) return { ok: false, error: '신청 일수를 입력하세요.' };

    const supabase = await createClient();

    // Checked against the balance rather than left to approval: a request that
    // cannot be granted wastes the line manager's attention and the worker's
    // week of waiting.
    const year = Number(input.startDate.slice(0, 4));
    const { data: balance } = await supabase
      .from('leave_balances')
      .select('entitled, used')
      .eq('employee_id', session.employee_id)
      .eq('leave_type_id', input.leaveTypeId)
      .eq('year', year)
      .maybeSingle();
    if (balance) {
      // Pending requests count against the balance too. Without that, three
      // requests for the last three days each pass on their own and the
      // fourth day of leave arrives as a surprise.
      const { data: pending } = await supabase
        .from('leaves')
        .select('days')
        .eq('employee_id', session.employee_id)
        .eq('leave_type_id', input.leaveTypeId)
        .eq('status', 'pending');
      const held = (pending ?? []).reduce((s, l) => s + Number(l.days), 0);
      const remaining = Number(balance.entitled) - Number(balance.used) - held;
      if (remaining < input.days) {
        return {
          ok: false,
          error:
            held > 0
              ? `잔여 ${remaining}일 (승인 대기 ${held}일 차감)로는 ${input.days}일을 신청할 수 없습니다.`
              : `잔여 ${remaining}일로는 ${input.days}일을 신청할 수 없습니다.`,
        };
      }
    }

    const { data: emp } = await supabase
      .from('employees')
      .select('company_id')
      .eq('id', session.employee_id)
      .maybeSingle();

    const { error } = await supabase.from('leaves').insert({
      company_id: emp?.company_id,
      employee_id: session.employee_id,
      leave_type_id: input.leaveTypeId,
      start_date: input.startDate,
      end_date: input.endDate,
      days: input.days,
      reason: input.reason || null,
      status: 'pending',
    });
    if (error) throw error;

    revalidatePath('/me/attendance');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '신청에 실패했습니다.' };
  }
}
