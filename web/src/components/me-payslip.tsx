'use client';

import { useEffect, useState } from 'react';
import { markPayslipOpenedAction } from '@/app/me/actions';
import { formatRupiah } from '@/lib/format';

export interface SlipLine {
  code: string;
  name: string;
  kind: string;
  amount: number;
  legal_basis: string | null;
}

/**
 * The payslip, and the fact that it was opened.
 *
 * The open is recorded from here because this is the only place it is true.
 * HR marking a payslip delivered says it was sent; this says somebody read it,
 * which is the question a dispute actually asks.
 */
export function PayslipView({
  payrollItemId,
  net,
  gross,
  deductionTotal,
  workDays,
  otMinutes,
  lines,
  alreadyOpened,
  delivered,
}: {
  payrollItemId: string;
  net: number;
  gross: number;
  deductionTotal: number;
  workDays: number;
  otMinutes: number;
  lines: SlipLine[];
  alreadyOpened: boolean;
  delivered: boolean;
}) {
  const [opened, setOpened] = useState(alreadyOpened);

  useEffect(() => {
    // Only when a delivery record exists and has not been opened. Firing on
    // every render would rewrite the timestamp on every visit.
    if (!delivered || alreadyOpened) return;
    let cancelled = false;
    markPayslipOpenedAction(payrollItemId).then((r) => {
      if (!cancelled && r.ok) setOpened(true);
    });
    return () => {
      cancelled = true;
    };
  }, [payrollItemId, delivered, alreadyOpened]);

  const earnings = lines.filter((l) => l.kind === 'earning');
  const deductions = lines.filter((l) => l.kind !== 'earning');
  const statutory = new Set(['PPH21']);

  return (
    <>
      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">실지급액</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{formatRupiah(net)}</p>
        <div className="mt-2 flex justify-between text-sm text-neutral-600 dark:text-neutral-400">
          <span>지급총액 {formatRupiah(gross)}</span>
          <span>공제 −{formatRupiah(deductionTotal)}</span>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          근무 {workDays}일
          {otMinutes > 0 &&
            ` · 초과근무 ${Math.floor(otMinutes / 60)}시간 ${otMinutes % 60}분`}
        </p>
      </section>

      <Section title="지급 항목" lines={earnings} sign="" />
      <Section title="공제 항목" lines={deductions} sign="−" />

      {deductions.length > 0 && (
        <p className="mt-2 text-xs text-neutral-500">
          BPJS·PPh 21은 법정 공제이고, 대출 상환은 본인이 신청한 공제입니다.
          {deductions.some((d) => statutory.has(d.code)) && ''}
        </p>
      )}

      {delivered && (
        <p className="mt-3 text-xs text-neutral-500">
          {opened ? '열람 기록이 저장되었습니다.' : '열람 기록을 저장하는 중입니다.'}
        </p>
      )}
    </>
  );
}

function Section({ title, lines, sign }: { title: string; lines: SlipLine[]; sign: string }) {
  if (lines.length === 0) return null;
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-2 space-y-1.5 text-sm">
        {lines.map((l, i) => (
          <li key={`${l.code}-${i}`} className="flex items-baseline justify-between gap-3">
            <span>
              {l.name}
              {l.legal_basis && (
                <span className="ml-1 text-xs text-neutral-500">({l.legal_basis})</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums">
              {sign}
              {formatRupiah(l.amount)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
