'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  initApprovalsAction,
  signApprovalAction,
  generatePaymentFileAction,
  distributePayslipsAction,
  generateFilingsAction,
  lockRunAction,
} from '@/app/payroll/payout-actions';
import { formatRupiah } from '@/lib/format';

export interface ApprovalView {
  step_no: number;
  role_label: string;
  approver_id: string | null;
  approver_name: string | null;
  signed_at: string | null;
  status: string;
}

export interface PaymentFileView {
  id: string;
  file_hash: string | null;
  total_amount: number;
  record_count: number;
  status: string;
  generated_at: string;
}

export interface FilingView {
  kind: string;
  period: string;
  total_amount: number | null;
  status: string;
}

export interface PayslipStats {
  total: number;
  byChannel: { channel: string; queued: number; opened: number }[];
}

const FILING_NAMES: Record<string, string> = {
  ebupot_pph21: 'e-Bupot · PPh 21',
  sipp_bpjs: 'SIPP · BPJS',
};

interface Props {
  runId: string;
  runStatus: string;
  approvals: ApprovalView[];
  paymentFile: PaymentFileView | null;
  filings: FilingView[];
  payslips: PayslipStats;
  employeeCount: number;
  canAct: boolean;
  currentUserId: string;
}

export function PayoutPanel({
  runId,
  runStatus,
  approvals,
  paymentFile,
  filings,
  payslips,
  employeeCount,
  canAct,
  currentUserId,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<
    { employee_no: string; employee_name: string; reason: string }[]
  >([]);

  const sorted = [...approvals].sort((a, b) => a.step_no - b.step_no);
  const nextStep = sorted.find((a) => a.status !== 'approved')?.step_no ?? null;
  const chainDone = sorted.length > 0 && sorted.every((a) => a.status === 'approved');
  // Delegation is not permitted, so an account that already signed is shown as
  // ineligible rather than being allowed to click and be refused.
  const alreadySigned = sorted.some(
    (a) => a.approver_id === currentUserId && a.status === 'approved'
  );

  function run(fn: () => Promise<{ ok: boolean; error?: string; blocked?: typeof blocked; recordCount?: number; totalAmount?: number; distributed?: number }>, success: (r: Awaited<ReturnType<typeof fn>>) => string) {
    startTransition(async () => {
      setError(null);
      setMessage(null);
      setBlocked([]);
      const r = await fn();
      if (!r.ok) {
        setError(r.error ?? '처리에 실패했습니다.');
        if (r.blocked) setBlocked(r.blocked);
      } else {
        setMessage(success(r));
      }
      router.refresh();
    });
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">G4 · 승인·지급</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {runStatus === 'locked'
              ? '마감된 차수입니다. 더 이상 변경되지 않습니다.'
              : chainDone
                ? '결재 완료 · 이체파일을 생성할 수 있습니다.'
                : sorted.length === 0
                  ? 'G3 통과 후 결재선을 시작합니다.'
                  : `${sorted.find((a) => a.step_no === nextStep)?.role_label} 결재 대기`}
          </p>
        </div>
        {canAct && sorted.length === 0 && (
          <button
            disabled={pending || runStatus !== 'g3_passed'}
            onClick={() => run(() => initApprovalsAction(runId), () => '결재선을 시작했습니다.')}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            결재 상신
          </button>
        )}
      </div>

      {message && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {blocked.length > 0 && (
        <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm font-medium">지급 불가 {blocked.length}명 — 조치 후 다시 생성하세요.</p>
          <ul className="mt-2 space-y-1 text-sm">
            {blocked.map((b) => (
              <li key={b.employee_no}>
                <span className="font-mono">{b.employee_no}</span> {b.employee_name} · {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- 결재선 ------------------------------------------------------- */}
      {sorted.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {sorted.map((a) => {
            const signable = canAct && a.step_no === nextStep && !alreadySigned;
            const waiting = a.step_no === nextStep;
            return (
              <div
                key={a.step_no}
                className={`rounded-lg border p-4 ${
                  a.status === 'approved'
                    ? 'border-neutral-200 dark:border-neutral-800'
                    : waiting
                      ? 'border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950'
                      : 'border-neutral-200 opacity-60 dark:border-neutral-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {a.step_no}. {a.role_label}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {a.status === 'approved' ? '서명 완료' : waiting ? '대기' : '순서 전'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                  {a.status === 'approved'
                    ? `${a.approver_name ?? '—'} · ${a.signed_at ? new Date(a.signed_at).toLocaleString('ko-KR') : ''}`
                    : '—'}
                </p>
                {signable && (
                  <button
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => signApprovalAction(runId, a.step_no),
                        () => `${a.role_label} 서명이 기록되었습니다.`
                      )
                    }
                    className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    서명
                  </button>
                )}
                {canAct && waiting && alreadySigned && (
                  <p className="mt-3 text-xs text-neutral-500">
                    이미 다른 단계를 서명했습니다. 위임은 허용되지 않습니다.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* --- 이체파일 ----------------------------------------------------- */}
      <div className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">은행 이체파일</h3>
            <p className="mt-1 text-sm text-neutral-500">
              {paymentFile
                ? `${paymentFile.record_count}건 · ${formatRupiah(paymentFile.total_amount)}`
                : '아직 생성되지 않았습니다.'}
            </p>
          </div>
          {canAct && (
            <button
              disabled={pending || !chainDone}
              onClick={() =>
                run(
                  () => generatePaymentFileAction(runId),
                  (r) => `${r.recordCount}건 · ${formatRupiah(r.totalAmount ?? 0)} 생성`
                )
              }
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
            >
              {paymentFile ? '재생성' : '이체파일 생성'}
            </button>
          )}
        </div>
        {paymentFile && (
          <p className="mt-2 font-mono text-xs text-neutral-500">
            {paymentFile.file_hash} · {new Date(paymentFile.generated_at).toLocaleString('ko-KR')}
          </p>
        )}
        {/* The file itself is not kept: it carries every account number in the
            company in plaintext. The hash, the total and the count are what a
            reconciliation against the bank actually needs. */}
        <p className="mt-2 text-xs text-neutral-500">
          파일 본문은 계좌번호를 담고 있어 저장하지 않습니다. 해시·건수·합계만 남습니다.
        </p>
      </div>

      {/* --- 명세서 배포 --------------------------------------------------- */}
      <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">명세서 배포</h3>
            <p className="mt-1 text-sm text-neutral-500">
              {payslips.total === 0
                ? '아직 등록되지 않았습니다.'
                : payslips.byChannel
                    .map(
                      (c) =>
                        `${c.channel === 'whatsapp' ? 'WhatsApp' : '이메일'} ${c.queued}/${employeeCount}건 · 열람 ${c.opened}건`
                    )
                    .join(' · ')}
            </p>
          </div>
          {canAct && (
            <div className="flex gap-2">
              {(['whatsapp', 'email'] as const).map((ch) => (
                <button
                  key={ch}
                  disabled={pending || !chainDone}
                  onClick={() =>
                    run(
                      () => distributePayslipsAction(runId, ch),
                      (r) => `${r.distributed}건 발송 대기로 등록했습니다.`
                    )
                  }
                  className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
                >
                  {ch === 'whatsapp' ? 'WhatsApp 등록' : '이메일 등록'}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Queued, not sent. Marking these sent before an actual send would
            make the open-rate figure a number about nothing. */}
        <p className="mt-2 text-xs text-neutral-500">
          발송 연동 전까지는 대기 상태로 기록됩니다. 실제 발송·열람 시각은 연동 후 채워집니다.
        </p>
      </div>

      {/* --- 신고 초안 ----------------------------------------------------- */}
      <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">세무·사보 신고 초안</h3>
          {canAct && (
            <button
              disabled={pending || !chainDone}
              onClick={() => run(() => generateFilingsAction(runId), () => '신고 초안을 생성했습니다.')}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700 disabled:opacity-50"
            >
              초안 생성
            </button>
          )}
        </div>
        {filings.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">아직 생성되지 않았습니다.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {filings.map((f) => (
              <li key={f.kind} className="flex items-center justify-between">
                <span>
                  {FILING_NAMES[f.kind] ?? f.kind}{' '}
                  <span className="text-neutral-500">{f.period}</span>
                </span>
                <span className="tabular-nums">
                  {formatRupiah(f.total_amount ?? 0)}{' '}
                  <span className="text-xs text-neutral-500">
                    {f.status === 'draft' ? '초안' : f.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- 마감 --------------------------------------------------------- */}
      {canAct && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h3 className="text-base font-semibold">차수 마감</h3>
            <p className="mt-1 text-sm text-neutral-500">
              마감하면 이 차수의 계산·소명·결재가 모두 고정됩니다.
            </p>
          </div>
          <button
            disabled={pending || runStatus === 'locked' || !paymentFile}
            onClick={() => run(() => lockRunAction(runId), () => '차수를 마감했습니다.')}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {runStatus === 'locked' ? '마감됨' : '마감'}
          </button>
        </div>
      )}
    </section>
  );
}
