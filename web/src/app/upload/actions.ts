'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import {
  parseCsv,
  validateRows,
  summarise,
  buildErrorCsv,
  TEMPLATE_COLUMNS,
  type RowVerdict,
} from '@/lib/upload/pph21-template';

const ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];

async function requireRole() {
  const session = await requireSession();
  if (!ROLES.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface UploadResult {
  ok: boolean;
  error?: string;
  batchId?: string;
  total?: number;
  errors?: number;
  warnings?: number;
  missingColumns?: string[];
  extraColumns?: string[];
  created?: number;
  updated?: number;
}

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Parses, validates and stores one upload.
 *
 * Stored even when it fails validation: the error list is what the uploader
 * works from, and re-parsing a file they no longer have is not an option.
 */
export async function uploadBatchAction(input: {
  period: string;
  filename: string;
  csvText: string;
}): Promise<UploadResult> {
  try {
    const session = await requireRole();
    if (!/^\d{4}-\d{2}$/.test(input.period)) {
      return { ok: false, error: '차수는 YYYY-MM 형식이어야 합니다.' };
    }
    // Byte length, not character count: a file of Indonesian names and
    // addresses is comfortably larger in UTF-8 than its length suggests.
    if (Buffer.byteLength(input.csvText, 'utf8') > MAX_BYTES) {
      return { ok: false, error: '파일이 10MB를 초과합니다.' };
    }

    const supabase = await createClient();
    const parsed = parseCsv(input.csvText);

    if (parsed.rows.length === 0) {
      return {
        ok: false,
        error:
          parsed.header.length === 0
            ? '빈 파일입니다.'
            : '데이터 행이 없습니다 (헤더만 있는 파일입니다).',
        missingColumns: parsed.missingColumns,
      };
    }
    // Refused rather than accepted with blanks: a file missing gross_salary
    // would validate every row as "필수값 누락" and bury the real problem,
    // which is that the wrong file was picked.
    if (parsed.missingColumns.length > 0) {
      return {
        ok: false,
        error: `템플릿 컬럼 ${parsed.missingColumns.length}개가 없습니다. 템플릿을 다시 내려받아 작성하세요.`,
        missingColumns: parsed.missingColumns,
        extraColumns: parsed.extraColumns,
      };
    }

    const [umkRes, companyRes] = await Promise.all([
      supabase.from('umk_rates').select('region, amount'),
      supabase.from('companies').select('umk_region').maybeSingle(),
    ]);

    const verdicts = validateRows(parsed.rows, {
      umkByRegion: new Map((umkRes.data ?? []).map((u) => [u.region as string, Number(u.amount)])),
      defaultRegion: (companyRes.data?.umk_region as string | null) ?? null,
    });
    const summary = summarise(verdicts);

    const { data: batch, error } = await supabase
      .from('upload_batches')
      .insert({
        company_id: session.company_id,
        period: input.period,
        filename: input.filename,
        uploaded_by: session.id,
        row_count: summary.total,
        error_count: summary.errors,
        status: 'parsed',
      })
      .select('id')
      .single();
    if (error) throw error;

    // Chunked, because a 400-row file is one insert but a 5,000-row one is
    // over PostgREST's payload limit in a single statement.
    const CHUNK = 500;
    for (let i = 0; i < verdicts.length; i += CHUNK) {
      const { error: rowError } = await supabase.from('upload_rows').insert(
        verdicts.slice(i, i + CHUNK).map((v) => ({
          company_id: session.company_id,
          batch_id: batch.id as string,
          row_no: v.row_no,
          employee_number: v.employee_number || null,
          data: v.data,
          errors: [...v.errors, ...v.warnings.map((w) => `[경고] ${w}`)],
        }))
      );
      if (rowError) throw rowError;
    }

    await supabase.rpc('log_audit', {
      p_action: 'SOURCE_DATA_UPLOADED',
      p_target_table: 'upload_batches',
      p_target_id: batch.id as string,
      p_details: {
        period: input.period,
        filename: input.filename,
        rows: summary.total,
        errors: summary.errors,
      },
    });

    revalidatePath('/upload');
    return {
      ok: true,
      batchId: batch.id as string,
      total: summary.total,
      errors: summary.errors,
      warnings: summary.warnings,
      extraColumns: parsed.extraColumns,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '업로드에 실패했습니다.' };
  }
}

/**
 * Writes a clean batch onto the employee master.
 *
 * Only creates and updates the employees named in the file. Somebody left out
 * of a spreadsheet has not resigned, and treating an absence as a departure is
 * how people stop being paid without anybody deciding it.
 */
export async function applyBatchAction(batchId: string): Promise<UploadResult> {
  try {
    const session = await requireRole();
    const supabase = await createClient();

    const { data: batch } = await supabase
      .from('upload_batches')
      .select('*')
      .eq('id', batchId)
      .maybeSingle();
    if (!batch) return { ok: false, error: '업로드를 찾을 수 없습니다.' };
    if (batch.status === 'applied') return { ok: false, error: '이미 적용된 업로드입니다.' };
    if (batch.status === 'discarded') return { ok: false, error: '폐기된 업로드입니다.' };
    if (Number(batch.error_count) > 0) {
      return {
        ok: false,
        error: `오류 ${batch.error_count}건을 모두 해결해야 적용할 수 있습니다.`,
      };
    }

    const { data: rows } = await supabase
      .from('upload_rows')
      .select('row_no, employee_number, data')
      .eq('batch_id', batchId)
      .order('row_no');
    if ((rows ?? []).length === 0) return { ok: false, error: '적용할 행이 없습니다.' };

    const [empRes, deptRes, posRes] = await Promise.all([
      supabase.from('employees').select('id, employee_no'),
      supabase.from('departments').select('id, name'),
      supabase.from('positions').select('id, name'),
    ]);
    const existing = new Map((empRes.data ?? []).map((e) => [String(e.employee_no), e.id as string]));
    const deptByName = new Map((deptRes.data ?? []).map((d) => [String(d.name), d.id as string]));
    const posByName = new Map((posRes.data ?? []).map((p) => [String(p.name), p.id as string]));

    let created = 0;
    let updated = 0;

    for (const r of rows ?? []) {
      const d = r.data as Record<string, string>;
      const empNo = String(r.employee_number ?? '').trim();
      if (!empNo) continue;

      const patch: Record<string, unknown> = {
        full_name: d.employee_name,
        // Blank means "not supplied", never "clear it". A template filled in
        // for a pay change should not wipe somebody's NPWP.
        ...(d.employee_npwp ? { npwp: d.employee_npwp } : {}),
        ...(d.employee_nik ? { nik: d.employee_nik } : {}),
        ...(d.ptkp_category ? { ptkp_status: d.ptkp_category } : {}),
        ...(d.gross_salary ? { base_salary: Number(d.gross_salary) } : {}),
        ...(d.birth_date ? { birth_date: d.birth_date } : {}),
        ...(d.gender ? { gender: d.gender } : {}),
        ...(d.join_date ? { join_date: d.join_date } : {}),
        ...(d.resign_date ? { resign_date: d.resign_date, is_active: false } : {}),
        ...(deptByName.has(d.department) ? { department_id: deptByName.get(d.department) } : {}),
        ...(posByName.has(d.position) ? { position_id: posByName.get(d.position) } : {}),
        updated_at: new Date().toISOString(),
      };

      const id = existing.get(empNo);
      if (id) {
        const { error } = await supabase
          .from('employees')
          .update(patch)
          .eq('id', id)
          .eq('company_id', session.company_id);
        if (error) throw error;
        updated += 1;
      } else {
        if (!d.join_date) {
          return {
            ok: false,
            error: `${empNo}: 신규 직원은 join_date가 필요합니다. ${created + updated}건 적용 후 중단했습니다.`,
            created,
            updated,
          };
        }
        const { error } = await supabase.from('employees').insert({
          ...patch,
          company_id: session.company_id,
          employee_no: empNo,
          is_active: !d.resign_date,
        });
        if (error) throw error;
        created += 1;
      }
    }

    await supabase
      .from('upload_batches')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: session.id,
        created_employees: created,
        updated_employees: updated,
        updated_at: new Date().toISOString(),
      })
      .eq('id', batchId);

    await supabase.rpc('log_audit', {
      p_action: 'SOURCE_DATA_APPLIED',
      p_target_table: 'upload_batches',
      p_target_id: batchId,
      p_details: { created, updated, period: batch.period },
    });

    revalidatePath('/upload');
    revalidatePath('/employees');
    return { ok: true, created, updated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '적용에 실패했습니다.' };
  }
}

export async function discardBatchAction(batchId: string): Promise<UploadResult> {
  try {
    await requireRole();
    const supabase = await createClient();

    const { data: batch } = await supabase
      .from('upload_batches')
      .select('status')
      .eq('id', batchId)
      .maybeSingle();
    if (!batch) return { ok: false, error: '업로드를 찾을 수 없습니다.' };
    // An applied batch is the record of what changed the master. Discarding it
    // would leave the change with no explanation.
    if (batch.status === 'applied') {
      return { ok: false, error: '이미 적용된 업로드는 폐기할 수 없습니다.' };
    }

    const { error } = await supabase
      .from('upload_batches')
      .update({ status: 'discarded', updated_at: new Date().toISOString() })
      .eq('id', batchId);
    if (error) throw error;

    revalidatePath('/upload');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' };
  }
}

/** Only the failed rows, with their reasons, for fixing and re-uploading. */
export async function errorCsvAction(batchId: string): Promise<{ ok: boolean; csv?: string; error?: string }> {
  try {
    await requireRole();
    const supabase = await createClient();

    const { data: rows } = await supabase
      .from('upload_rows')
      .select('row_no, employee_number, data, errors')
      .eq('batch_id', batchId)
      .order('row_no');
    if ((rows ?? []).length === 0) return { ok: false, error: '행이 없습니다.' };

    const verdicts: RowVerdict[] = (rows ?? []).map((r) => {
      const all = (r.errors as string[]) ?? [];
      return {
        row_no: Number(r.row_no),
        employee_number: String(r.employee_number ?? ''),
        data: r.data as Record<string, string>,
        errors: all.filter((e) => !e.startsWith('[경고]')),
        warnings: all.filter((e) => e.startsWith('[경고]')),
      };
    });
    if (verdicts.every((v) => v.errors.length === 0)) {
      return { ok: false, error: '오류 행이 없습니다.' };
    }

    // Template order, not the jsonb key order Postgres hands back. The point
    // of this file is that it can be corrected and re-uploaded, and a header
    // in storage order is not the template.
    return { ok: true, csv: buildErrorCsv(verdicts, [...TEMPLATE_COLUMNS]) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '생성에 실패했습니다.' };
  }
}
