import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { UploadPanel, type BatchRow, type PreviewRow } from '@/components/upload-panel';

export const dynamic = 'force-dynamic';

const ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];
/** How many rows the preview renders. A 400-row table is fine; 5,000 is not. */
const PREVIEW_LIMIT = 200;

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!ROLES.includes(session.role)) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">원천데이터 업로드</h1>
        <p className="mt-3 text-sm text-neutral-500">이 화면을 볼 권한이 없습니다.</p>
      </main>
    );
  }

  const { batch: requested } = await searchParams;
  const supabase = await createClient();

  const { data: batchRows } = await supabase
    .from('upload_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  const uploaderIds = [
    ...new Set((batchRows ?? []).map((b) => b.uploaded_by as string | null).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string>();
  if (uploaderIds.length > 0) {
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name')
      .in('id', uploaderIds);
    for (const u of users ?? []) names.set(u.id as string, u.full_name as string);
  }

  const batches: BatchRow[] = (batchRows ?? []).map((b) => ({
    id: b.id as string,
    period: b.period as string,
    filename: (b.filename as string | null) ?? null,
    uploader: b.uploaded_by ? (names.get(b.uploaded_by as string) ?? null) : null,
    created_at: b.created_at as string,
    row_count: Number(b.row_count),
    error_count: Number(b.error_count),
    status: b.status as string,
    created_employees: Number(b.created_employees),
    updated_employees: Number(b.updated_employees),
  }));

  // The newest live batch when none was asked for, so the screen opens on the
  // thing somebody is most likely still working through.
  const previewBatch =
    batches.find((b) => b.id === requested) ??
    batches.find((b) => b.status === 'parsed') ??
    null;

  let preview: PreviewRow[] = [];
  if (previewBatch) {
    // Flagged rows are fetched first and separately. Taking the first 200 by
    // row number and sorting afterwards would drop an error on row 350 out of
    // the preview entirely — the one thing the screen exists to show.
    const [flaggedRes, cleanRes] = await Promise.all([
      supabase
        .from('upload_rows')
        .select('row_no, employee_number, data, errors')
        .eq('batch_id', previewBatch.id)
        .neq('errors', '[]')
        .order('row_no')
        .limit(PREVIEW_LIMIT),
      supabase
        .from('upload_rows')
        .select('row_no, employee_number, data, errors')
        .eq('batch_id', previewBatch.id)
        .eq('errors', '[]')
        .order('row_no')
        .limit(PREVIEW_LIMIT),
    ]);

    const toRow = (r: Record<string, unknown>): PreviewRow => ({
      row_no: Number(r.row_no),
      employee_number: (r.employee_number as string | null) ?? null,
      data: r.data as Record<string, string>,
      errors: (r.errors as string[]) ?? [],
    });

    const flagged = (flaggedRes.data ?? []).map(toRow).sort((a, b) => {
      // Errors above warnings, then by row number.
      const ae = a.errors.some((e) => !e.startsWith('[경고]')) ? 0 : 1;
      const be = b.errors.some((e) => !e.startsWith('[경고]')) ? 0 : 1;
      return ae - be || a.row_no - b.row_no;
    });
    preview = [
      ...flagged,
      ...(cleanRes.data ?? []).map(toRow).slice(0, Math.max(0, PREVIEW_LIMIT - flagged.length)),
    ];
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">원천데이터 업로드</h1>
      <p className="mt-1 text-sm text-neutral-500">
        PPh 21 템플릿으로 직원 마스터와 급여 기초자료를 올립니다. 오류가 없는 업로드만 적용할 수
        있습니다.
      </p>

      <UploadPanel
        batches={batches}
        preview={preview}
        previewBatch={previewBatch}
        canAct={ROLES.includes(session.role)}
      />
    </main>
  );
}
