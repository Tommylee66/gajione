'use client';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm dark:border-neutral-700"
    >
      인쇄 · PDF 저장
    </button>
  );
}
