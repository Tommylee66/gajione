/** Rupiah has no subunit in practice, so amounts are shown whole. */
export function formatRupiah(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return 'Rp' + Math.round(amount).toLocaleString('id-ID');
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

const EMPLOYMENT_LABELS: Record<string, string> = {
  permanent: '정규직',
  contract: '계약직',
  probation: '수습',
  daily: '일용직',
  intern: '인턴',
};

export function employmentLabel(type: string): string {
  return EMPLOYMENT_LABELS[type] ?? type;
}
