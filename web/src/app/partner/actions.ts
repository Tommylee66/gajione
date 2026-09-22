'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { buildSchedule, validateOffer, type RepaymentMethod } from '@/lib/credit/offer';

/**
 * The partner's side of a loan.
 *
 * Everything here is the lender acting, not GajiOne acting on their behalf.
 * The terms are theirs, the decision is theirs, and what this file does is
 * record it and refuse what the rules do not allow.
 */
async function requireLender() {
  const session = await requireSession();
  if (session.role !== 'lender_officer') throw new Error('Forbidden: 금융기관 담당자만 사용할 수 있습니다.');
  if (!session.lender_id) throw new Error('소속 금융기관이 지정되지 않은 계정입니다.');
  return session;
}

export interface PartnerResult {
  ok: boolean;
  error?: string;
  offerId?: string;
}

export async function sendOfferAction(input: {
  referralId: string;
  annualRate: number;
  months: number;
  feePercent: number;
  method: RepaymentMethod;
  validDays: number;
}): Promise<PartnerResult> {
  try {
    const session = await requireLender();
    const supabase = await createClient();

    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('*')
      .eq('id', input.referralId)
      .maybeSingle();
    // RLS already scopes this to the partner's own referrals, so "not found"
    // and "not yours" are the same answer — which is the right answer.
    if (!ref) return { ok: false, error: '신청 건을 찾을 수 없습니다.' };
    if (ref.status !== 'referred') {
      return { ok: false, error: '심사 대기 중인 신청에만 오퍼를 보낼 수 있습니다.' };
    }

    // An outstanding offer has to be withdrawn first. Two live offers on one
    // application is two different deductions the employee could accept.
    const { data: live } = await supabase
      .from('loan_offers')
      .select('id')
      .eq('referral_id', input.referralId)
      .in('status', ['sent', 'accepted'])
      .limit(1);
    if ((live ?? []).length > 0) {
      return { ok: false, error: '이미 발송된 오퍼가 있습니다. 철회 후 다시 보내세요.' };
    }

    const terms = {
      principal: Number(ref.amount_requested),
      annualRate: input.annualRate,
      months: Math.round(input.months),
      feePercent: input.feePercent,
      method: input.method,
    };
    const problems = validateOffer(terms);
    if (problems.length > 0) {
      return { ok: false, error: problems.map((p) => p.reason).join(' · ') };
    }
    const validDays = Math.round(input.validDays);
    if (validDays < 1 || validDays > 30) {
      return { ok: false, error: '유효기간은 1~30일이어야 합니다.' };
    }

    const schedule = buildSchedule(terms);
    const expires = new Date(Date.now() + validDays * 86_400_000);

    const { data: offer, error } = await supabase
      .from('loan_offers')
      .insert({
        referral_id: input.referralId,
        lender_id: session.lender_id,
        company_id: ref.company_id as string,
        annual_rate: terms.annualRate,
        months: terms.months,
        fee_percent: terms.feePercent,
        repayment_method: terms.method,
        // Stored, not recomputed later: the figure the employee was shown is
        // the figure on file, whatever the formula does afterwards.
        monthly_amount: schedule.monthlyAmount,
        first_month_amount: schedule.firstMonthAmount,
        fee_amount: schedule.feeAmount,
        total_repayment: schedule.totalRepayment,
        expires_at: expires.toISOString(),
        status: 'sent',
      })
      .select('id')
      .single();
    if (error) throw error;

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_OFFER_SENT',
      p_target_table: 'loan_offers',
      p_target_id: offer.id as string,
      p_details: {
        referral_id: input.referralId,
        annual_rate: terms.annualRate,
        months: terms.months,
        fee_percent: terms.feePercent,
        method: terms.method,
        monthly_amount: schedule.monthlyAmount,
      },
    });

    revalidatePath('/partner');
    revalidatePath('/loans');
    return { ok: true, offerId: offer.id as string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '발송에 실패했습니다.' };
  }
}

export async function withdrawOfferAction(offerId: string, reason: string): Promise<PartnerResult> {
  try {
    await requireLender();
    const supabase = await createClient();

    const { data: offer } = await supabase
      .from('loan_offers')
      .select('status')
      .eq('id', offerId)
      .maybeSingle();
    if (!offer) return { ok: false, error: '오퍼를 찾을 수 없습니다.' };
    // An accepted offer is an agreement. Withdrawing it is a cancellation the
    // borrower has to be party to, not something done from a list.
    if (offer.status !== 'sent') {
      return { ok: false, error: '발송 상태의 오퍼만 철회할 수 있습니다.' };
    }

    const { data: touched, error } = await supabase
      .from('loan_offers')
      .update({
        status: 'withdrawn',
        decline_reason: reason || null,
        responded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', offerId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_OFFER_WITHDRAWN',
      p_target_table: 'loan_offers',
      p_target_id: offerId,
      p_details: { reason },
    });

    revalidatePath('/partner');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/** The partner declines the application outright, without an offer. */
export async function declineReferralAction(
  referralId: string,
  reason: string
): Promise<PartnerResult> {
  try {
    await requireLender();
    if (!reason.trim()) return { ok: false, error: '거절 사유를 입력하세요.' };
    const supabase = await createClient();

    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('status')
      .eq('id', referralId)
      .maybeSingle();
    if (!ref) return { ok: false, error: '신청 건을 찾을 수 없습니다.' };
    if (ref.status !== 'referred') {
      return { ok: false, error: '심사 대기 중인 신청만 거절할 수 있습니다.' };
    }

    const { data: touched, error } = await supabase
      .from('loan_referrals')
      .update({
        status: 'rejected',
        lender_decision: 'rejected',
        decline_reason: reason,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', referralId)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_DECLINED_BY_LENDER',
      p_target_table: 'loan_referrals',
      p_target_id: referralId,
      p_details: { reason },
    });

    revalidatePath('/partner');
    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/**
 * The money has left. Recorded by the lender because only they know when.
 *
 * This is also the point the referral becomes 'approved' with a reference
 * number — which is what HR's deduction setup requires, so the manual
 * "record what the lender said" step stops being needed for partners on the
 * portal.
 */
export async function recordDisbursementAction(
  offerId: string,
  lenderRefNo: string
): Promise<PartnerResult> {
  try {
    await requireLender();
    if (!lenderRefNo.trim()) return { ok: false, error: '금융기관 참조번호가 있어야 합니다.' };
    const supabase = await createClient();

    const { data: offer } = await supabase
      .from('loan_offers')
      .select('*')
      .eq('id', offerId)
      .maybeSingle();
    if (!offer) return { ok: false, error: '오퍼를 찾을 수 없습니다.' };
    if (offer.status !== 'accepted') {
      return { ok: false, error: '직원이 수락한 오퍼만 실행할 수 있습니다.' };
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('loan_offers')
      .update({
        status: 'disbursed',
        disbursed_at: now,
        lender_ref_no: lenderRefNo.trim(),
        updated_at: now,
      })
      .eq('id', offerId);
    if (error) throw error;

    const { error: refError } = await supabase
      .from('loan_referrals')
      .update({
        status: 'approved',
        lender_decision: 'approved',
        lender_ref_no: lenderRefNo.trim(),
        decided_at: now,
        updated_at: now,
      })
      .eq('id', offer.referral_id as string);
    if (refError) throw refError;

    // The lender's own book, mirrored for reconciliation. Written here rather
    // than waited for, so the first deduction has something to check against.
    const { data: ref } = await supabase
      .from('loan_referrals')
      .select('employee_id, company_id, amount_requested')
      .eq('id', offer.referral_id as string)
      .maybeSingle();
    if (ref) {
      await supabase.from('loan_mirrors').upsert(
        {
          company_id: ref.company_id as string,
          employee_id: ref.employee_id as string,
          lender_id: offer.lender_id as string,
          lender_ref_no: lenderRefNo.trim(),
          principal: Number(ref.amount_requested),
          balance: Number(offer.total_repayment),
          paid_installments: 0,
          total_installments: Number(offer.months),
          is_overdue: false,
          synced_at: now,
        },
        { onConflict: 'lender_id,lender_ref_no' }
      );
    }

    await supabase.rpc('log_audit', {
      p_action: 'LOAN_DISBURSED',
      p_target_table: 'loan_offers',
      p_target_id: offerId,
      p_details: { lender_ref_no: lenderRefNo, months: offer.months },
    });

    revalidatePath('/partner');
    revalidatePath('/loans');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}
