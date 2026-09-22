import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptAccount, type EncryptedPayload } from '@/lib/crypto/account-encryption';

/**
 * One device poll.
 *
 * Shared by the button on the screen and by the scheduler, so the two cannot
 * drift: a sync that only the manual path validates is a sync the scheduler
 * gets wrong at three in the morning with nobody watching.
 *
 * Takes a client rather than creating one — the screen runs as the signed-in
 * user under RLS, the scheduler runs as the service role across every tenant,
 * and everything below is identical either way.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export interface SyncOutcome {
  ok: boolean;
  error?: string;
  records?: number;
  skipped?: number;
  durationMs: number;
  /** False when nothing was attempted — no endpoint, polling switched off. */
  attempted: boolean;
}

/** How many consecutive failures before scheduled polling backs off. */
export const FAILURE_LIMIT = 20;

export async function runDeviceSync(
  supabase: DB,
  companyId: string,
  deviceId: string | null
): Promise<SyncOutcome> {
  const started = Date.now();

  const log = async (status: 'success' | 'failed' | 'partial', detail: string, records: number) => {
    await supabase.from('device_sync_logs').insert({
      company_id: companyId,
      device_id: deviceId,
      kind: deviceId ? 'device' : 'full',
      status,
      record_count: records,
      duration_ms: Date.now() - started,
      detail,
    });
  };

  const { data: integration } = await supabase
    .from('device_integrations')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!integration?.endpoint_url) {
    return {
      ok: false,
      attempted: false,
      durationMs: Date.now() - started,
      error: '엔드포인트가 설정되지 않았습니다. API 연동 설정을 먼저 저장하세요.',
    };
  }

  // Recorded before the call, not after: a request that never returns still
  // has to count as an attempt, or the scheduler retries it every tick.
  await supabase
    .from('device_integrations')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('company_id', companyId);

  let credential = '';
  if (integration.credential_encrypted) {
    try {
      credential = decryptAccount(integration.credential_encrypted as EncryptedPayload);
    } catch {
      const reason = '저장된 인증정보를 복호화하지 못했습니다 (키 불일치)';
      await log('failed', reason, 0);
      await markFailure(supabase, companyId, reason);
      return {
        ok: false,
        attempted: true,
        durationMs: Date.now() - started,
        error: '저장된 인증정보를 읽을 수 없습니다. 인증정보를 다시 저장하세요.',
      };
    }
  }

  const url = new URL(integration.endpoint_url as string);
  if (deviceId) {
    const { data: device } = await supabase
      .from('devices')
      .select('code')
      .eq('id', deviceId)
      .maybeSingle();
    if (!device) {
      return {
        ok: false,
        attempted: false,
        durationMs: Date.now() - started,
        error: '장치를 찾을 수 없습니다.',
      };
    }
    url.searchParams.set('device', device.code as string);
  }

  // Bounded, because a device that accepts the connection and never answers
  // would otherwise hold the request until the platform times it out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: credential
        ? integration.auth_method === 'oauth2'
          ? { Authorization: `Bearer ${credential}` }
          : { 'X-API-Key': credential }
        : {},
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = describeFetchFailure(e);
    await log('failed', reason, 0);
    await markFailure(supabase, companyId, reason);
    return {
      ok: false,
      attempted: true,
      durationMs: Date.now() - started,
      error: `장치 연동에 실패했습니다: ${reason}`,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    const reason = `HTTP ${response.status}`;
    await log('failed', reason, 0);
    await markFailure(supabase, companyId, reason);
    return {
      ok: false,
      attempted: true,
      durationMs: Date.now() - started,
      error: `장치가 ${reason}로 응답했습니다.`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const reason = '응답이 JSON이 아닙니다';
    await log('failed', reason, 0);
    await markFailure(supabase, companyId, reason);
    return {
      ok: false,
      attempted: true,
      durationMs: Date.now() - started,
      error: '장치 응답을 해석할 수 없습니다 (JSON 아님).',
    };
  }

  const punches = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { records?: unknown }).records)
      ? (payload as { records: unknown[] }).records
      : null;
  if (!punches) {
    const reason = '응답에 레코드 배열이 없습니다';
    await log('failed', reason, 0);
    await markFailure(supabase, companyId, reason);
    return {
      ok: false,
      attempted: true,
      durationMs: Date.now() - started,
      error: '장치 응답에 근태 레코드가 없습니다.',
    };
  }

  let stored: { inserted: number; skipped: number };
  try {
    stored = await storePunches(supabase, companyId, punches as Record<string, unknown>[]);
  } catch (e) {
    const reason = describeFetchFailure(e);
    await log('failed', reason, 0);
    await markFailure(supabase, companyId, reason);
    return {
      ok: false,
      attempted: true,
      durationMs: Date.now() - started,
      error: `근태 저장에 실패했습니다: ${reason}`,
    };
  }

  const detail =
    stored.skipped > 0
      ? `${stored.inserted}건 저장 · ${stored.skipped}건 건너뜀 (사번 불일치)`
      : `${stored.inserted}건 저장`;
  await log(stored.skipped > 0 ? 'partial' : 'success', detail, stored.inserted);

  await supabase
    .from('device_integrations')
    .update({
      last_status: 'ok',
      last_error: null,
      consecutive_failures: 0,
      ...(deviceId ? {} : { last_full_sync_at: new Date().toISOString() }),
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);

  if (deviceId) {
    await supabase
      .from('devices')
      .update({
        last_sync_at: new Date().toISOString(),
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', deviceId);
  }

  return {
    ok: true,
    attempted: true,
    records: stored.inserted,
    skipped: stored.skipped,
    durationMs: Date.now() - started,
  };
}

async function markFailure(supabase: DB, companyId: string, reason: string) {
  const { data: current } = await supabase
    .from('device_integrations')
    .select('consecutive_failures')
    .eq('company_id', companyId)
    .maybeSingle();
  await supabase
    .from('device_integrations')
    .update({
      last_status: 'failed',
      last_error: reason,
      consecutive_failures: Number(current?.consecutive_failures ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
}

/**
 * Node's fetch reports every network failure as "TypeError: fetch failed" and
 * puts the reason underneath in `cause`. Surfacing the wrapper tells whoever
 * is looking at the sync log nothing at all — refused, unresolvable and
 * untrusted certificate are three different problems with three different
 * fixes.
 */
export function describeFetchFailure(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') return '응답 시간 초과 (15초)';
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return '연결이 거부되었습니다 (ECONNREFUSED) — 주소·포트를 확인하세요';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `호스트를 찾을 수 없습니다 (${code})`;
    case 'ETIMEDOUT':
      return '연결 시간 초과 (ETIMEDOUT)';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `인증서를 검증할 수 없습니다 (${code})`;
    default:
      return code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
  }
}

/**
 * Writes what came back into attendance_raw.
 *
 * A punch for an employee number we do not have is skipped and counted, never
 * dropped quietly: it usually means a device still holds a leaver, or someone
 * was enrolled on the device before HR. Either way somebody needs to know.
 */
async function storePunches(
  supabase: DB,
  companyId: string,
  punches: Record<string, unknown>[]
): Promise<{ inserted: number; skipped: number }> {
  if (punches.length === 0) return { inserted: 0, skipped: 0 };

  const { data: employees } = await supabase
    .from('employees')
    .select('id, employee_no')
    .eq('company_id', companyId);
  const byNo = new Map((employees ?? []).map((e) => [String(e.employee_no), e.id as string]));
  const { data: devices } = await supabase
    .from('devices')
    .select('id, code')
    .eq('company_id', companyId);
  const deviceByCode = new Map((devices ?? []).map((d) => [String(d.code), d.id as string]));

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const p of punches) {
    const no = String(p.employee_no ?? p.employeeNo ?? p.badge ?? '');
    const employeeId = byNo.get(no);
    const punchedAt = String(p.punched_at ?? p.punchedAt ?? p.timestamp ?? '');
    const direction = String(p.direction ?? p.type ?? '').toLowerCase();
    if (!employeeId || !punchedAt || (direction !== 'in' && direction !== 'out')) {
      skipped += 1;
      continue;
    }
    rows.push({
      company_id: companyId,
      employee_id: employeeId,
      device_id: deviceByCode.get(String(p.device ?? p.device_code ?? '')) ?? null,
      punched_at: punchedAt,
      direction,
      gps_lat: p.gps_lat ?? null,
      gps_lng: p.gps_lng ?? null,
      source: 'device',
      // Kept so a disputed punch can be checked against exactly what the
      // device sent, not against our reading of it.
      raw_payload: p,
    });
  }

  if (rows.length === 0) return { inserted: 0, skipped };
  const { error } = await supabase.from('attendance_raw').insert(rows);
  if (error) throw error;
  return { inserted: rows.length, skipped };
}
