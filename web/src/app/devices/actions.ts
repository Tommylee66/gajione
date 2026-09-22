'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { encryptAccount, decryptAccount, type EncryptedPayload } from '@/lib/crypto/account-encryption';

const EDIT_ROLES = ['hr_admin', 'operator_admin'];
const SYNC_ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];

async function requireRole(roles: string[]) {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw new Error('Forbidden: 권한이 없습니다.');
  if (!session.company_id) throw new Error('회사가 지정되지 않은 계정입니다.');
  return session;
}

export interface DeviceResult {
  ok: boolean;
  error?: string;
  records?: number;
  durationMs?: number;
}

export async function updateIntegrationAction(input: {
  endpointUrl: string;
  authMethod: 'api_key' | 'oauth2';
  /** Empty means "leave the stored credential alone" — the form never shows it. */
  credential: string;
  pollingMinutes: number;
  webhookUrl: string;
}): Promise<DeviceResult> {
  try {
    const session = await requireRole(EDIT_ROLES);

    const endpoint = input.endpointUrl.trim();
    if (endpoint) {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        return { ok: false, error: '엔드포인트 URL 형식이 올바르지 않습니다.' };
      }
      // The credential travels on every poll. Over http it travels in the
      // clear, and a device API key reaches every punch in the company.
      if (url.protocol !== 'https:') {
        return { ok: false, error: '엔드포인트는 https여야 합니다. 인증정보가 평문으로 오갑니다.' };
      }
    }
    if (input.webhookUrl.trim()) {
      try {
        const w = new URL(input.webhookUrl.trim());
        if (w.protocol !== 'https:') {
          return { ok: false, error: 'Webhook URL은 https여야 합니다.' };
        }
      } catch {
        return { ok: false, error: 'Webhook URL 형식이 올바르지 않습니다.' };
      }
    }
    if (![5, 15, 30, 60].includes(input.pollingMinutes)) {
      return { ok: false, error: '폴링 주기는 5·15·30·60분 중 하나여야 합니다.' };
    }

    const supabase = await createClient();
    const patch: Record<string, unknown> = {
      endpoint_url: endpoint || null,
      auth_method: input.authMethod,
      polling_minutes: input.pollingMinutes,
      webhook_url: input.webhookUrl.trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (input.credential.trim()) {
      patch.credential_encrypted = encryptAccount(input.credential.trim());
      patch.credential_hint = input.credential.trim().slice(-4);
    }

    const { data: touched, error } = await supabase
      .from('device_integrations')
      .update(patch)
      .eq('company_id', session.company_id)
      .select('id');
    if (error) throw error;
    if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };

    await supabase.rpc('log_audit', {
      p_action: 'DEVICE_INTEGRATION_UPDATED',
      p_target_table: 'device_integrations',
      p_target_id: session.company_id,
      p_details: {
        endpoint: endpoint || null,
        auth_method: input.authMethod,
        polling_minutes: input.pollingMinutes,
        // Never the credential itself, and not even its length.
        credential_changed: Boolean(input.credential.trim()),
      },
    });

    revalidatePath('/devices');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}

/**
 * Polls the device endpoint.
 *
 * Actually calls it. The alternative — marking rows synced and writing a
 * success line — would make the sync log a record of nothing, and "the device
 * was offline that morning" is exactly the answer a missing punch needs.
 *
 * Every attempt is logged, failures included, and the device's own status is
 * set from the outcome rather than assumed.
 */
export async function syncDevicesAction(deviceId: string | null): Promise<DeviceResult> {
  const started = Date.now();
  let session;
  let supabase;
  try {
    session = await requireRole(SYNC_ROLES);
    supabase = await createClient();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '권한이 없습니다.' };
  }

  const log = async (
    status: 'success' | 'failed' | 'partial',
    detail: string,
    records: number
  ) => {
    await supabase!.from('device_sync_logs').insert({
      company_id: session!.company_id,
      device_id: deviceId,
      kind: deviceId ? 'device' : 'full',
      status,
      record_count: records,
      duration_ms: Date.now() - started,
      detail,
    });
  };

  try {
    const { data: integration } = await supabase
      .from('device_integrations')
      .select('*')
      .eq('company_id', session.company_id)
      .maybeSingle();

    if (!integration?.endpoint_url) {
      // Not logged as a failed sync: nothing was attempted, and a log line
      // here would read as the endpoint having been tried and refused.
      return { ok: false, error: '엔드포인트가 설정되지 않았습니다. API 연동 설정을 먼저 저장하세요.' };
    }

    let credential = '';
    if (integration.credential_encrypted) {
      try {
        credential = decryptAccount(integration.credential_encrypted as EncryptedPayload);
      } catch {
        await log('failed', '저장된 인증정보를 복호화하지 못했습니다 (키 불일치)', 0);
        return { ok: false, error: '저장된 인증정보를 읽을 수 없습니다. 인증정보를 다시 저장하세요.' };
      }
    }

    const url = new URL(integration.endpoint_url as string);
    if (deviceId) {
      const { data: device } = await supabase
        .from('devices')
        .select('code')
        .eq('id', deviceId)
        .maybeSingle();
      if (!device) return { ok: false, error: '장치를 찾을 수 없습니다.' };
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
      await markIntegration(supabase, session.company_id!, 'failed', reason);
      return { ok: false, error: `장치 연동에 실패했습니다: ${reason}` };
    }
    clearTimeout(timer);

    if (!response.ok) {
      const reason = `HTTP ${response.status}`;
      await log('failed', reason, 0);
      await markIntegration(supabase, session.company_id!, 'failed', reason);
      return { ok: false, error: `장치가 ${reason}로 응답했습니다.` };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await log('failed', '응답이 JSON이 아닙니다', 0);
      await markIntegration(supabase, session.company_id!, 'failed', '응답이 JSON이 아닙니다');
      return { ok: false, error: '장치 응답을 해석할 수 없습니다 (JSON 아님).' };
    }

    const punches = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { records?: unknown }).records)
        ? ((payload as { records: unknown[] }).records)
        : null;
    if (!punches) {
      await log('failed', '응답에 레코드 배열이 없습니다', 0);
      return { ok: false, error: '장치 응답에 근태 레코드가 없습니다.' };
    }

    const { inserted, skipped } = await storePunches(
      supabase,
      session.company_id!,
      punches as Record<string, unknown>[]
    );

    const detail = skipped > 0 ? `${inserted}건 저장 · ${skipped}건 건너뜀 (사번 불일치)` : `${inserted}건 저장`;
    await log(skipped > 0 ? 'partial' : 'success', detail, inserted);
    await markIntegration(supabase, session.company_id!, 'ok', null, !deviceId);

    if (deviceId) {
      await supabase
        .from('devices')
        .update({ last_sync_at: new Date().toISOString(), status: 'active', updated_at: new Date().toISOString() })
        .eq('id', deviceId);
    }

    revalidatePath('/devices');
    revalidatePath('/attendance');
    return { ok: true, records: inserted, durationMs: Date.now() - started };
  } catch (e) {
    const reason = e instanceof Error ? e.message : '알 수 없는 오류';
    await log('failed', reason, 0);
    return { ok: false, error: `동기화에 실패했습니다: ${reason}` };
  }
}

/**
 * Node's fetch reports every network failure as "TypeError: fetch failed" and
 * puts the reason underneath in `cause`. Surfacing the wrapper tells whoever
 * is looking at the sync log nothing at all — refused, unresolvable and
 * untrusted certificate are three different problems with three different
 * fixes.
 */
function describeFetchFailure(e: unknown): string {
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

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function markIntegration(
  supabase: Supabase,
  companyId: string,
  status: 'ok' | 'failed',
  error: string | null,
  fullSync = false
) {
  await supabase
    .from('device_integrations')
    .update({
      last_status: status,
      last_error: error,
      ...(fullSync && status === 'ok' ? { last_full_sync_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
}

/**
 * Writes what came back into attendance_raw.
 *
 * A punch for an employee number we do not have is skipped and counted, never
 * dropped quietly: it usually means a device still holds a leaver, or someone
 * was enrolled on the device before HR. Either way somebody needs to know.
 */
async function storePunches(
  supabase: Supabase,
  companyId: string,
  punches: Record<string, unknown>[]
): Promise<{ inserted: number; skipped: number }> {
  if (punches.length === 0) return { inserted: 0, skipped: 0 };

  const { data: employees } = await supabase.from('employees').select('id, employee_no');
  const byNo = new Map((employees ?? []).map((e) => [String(e.employee_no), e.id as string]));
  const { data: devices } = await supabase.from('devices').select('id, code');
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

export async function saveDeviceAction(input: {
  id?: string;
  code: string;
  name: string;
  deviceType: 'fingerprint' | 'mobile' | 'card' | 'face';
  location: string;
  status: 'active' | 'offline' | 'retired';
}): Promise<DeviceResult> {
  try {
    const session = await requireRole(EDIT_ROLES);
    if (!input.code.trim()) return { ok: false, error: '장치 ID는 필수입니다.' };
    const supabase = await createClient();

    const patch = {
      code: input.code.trim(),
      name: input.name.trim() || null,
      device_type: input.deviceType,
      location: input.location.trim() || null,
      status: input.status,
      updated_at: new Date().toISOString(),
    };

    if (input.id) {
      const { data: touched, error } = await supabase
        .from('devices')
        .update(patch)
        .eq('id', input.id)
        .eq('company_id', session.company_id)
        .select('id');
      if (error) throw error;
      if ((touched ?? []).length === 0) return { ok: false, error: '변경할 권한이 없습니다.' };
    } else {
      const { error } = await supabase
        .from('devices')
        .insert({ ...patch, company_id: session.company_id });
      if (error) throw error;
    }

    await supabase.rpc('log_audit', {
      p_action: input.id ? 'DEVICE_UPDATED' : 'DEVICE_CREATED',
      p_target_table: 'devices',
      p_target_id: input.id ?? session.company_id,
      p_details: { code: input.code, type: input.deviceType },
    });

    revalidatePath('/devices');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '저장에 실패했습니다.' };
  }
}
