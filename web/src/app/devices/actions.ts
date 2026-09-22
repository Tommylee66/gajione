'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';
import { encryptAccount } from '@/lib/crypto/account-encryption';
import { runDeviceSync } from '@/lib/devices/sync';

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
 * Polls the device endpoint on demand.
 *
 * The work itself lives in lib/devices/sync so the button and the scheduler
 * run the same code. What is left here is the part that only applies to a
 * person clicking: who they are, and refreshing the page afterwards.
 */
export async function syncDevicesAction(deviceId: string | null): Promise<DeviceResult> {
  let session;
  let supabase;
  try {
    session = await requireRole(SYNC_ROLES);
    supabase = await createClient();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '권한이 없습니다.' };
  }

  const outcome = await runDeviceSync(supabase, session.company_id!, deviceId);

  revalidatePath('/devices');
  revalidatePath('/attendance');
  return outcome.ok
    ? { ok: true, records: outcome.records, durationMs: outcome.durationMs }
    : { ok: false, error: outcome.error };
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
