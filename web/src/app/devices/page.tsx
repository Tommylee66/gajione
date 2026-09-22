import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import {
  DevicePanel,
  type DeviceRow,
  type IntegrationRow,
  type SyncLogRow,
} from '@/components/device-panel';

export const dynamic = 'force-dynamic';

const VIEW_ROLES = ['hr_admin', 'operator_admin', 'payroll_staff'];
const EDIT_ROLES = ['hr_admin', 'operator_admin'];

export default async function DevicesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!VIEW_ROLES.includes(session.role)) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">지문인식기 연동</h1>
        <p className="mt-3 text-sm text-neutral-500">이 화면을 볼 권한이 없습니다.</p>
      </main>
    );
  }

  const supabase = await createClient();
  const [deviceRes, integrationRes, logRes] = await Promise.all([
    supabase
      .from('devices')
      .select('id, code, name, device_type, location, status, last_sync_at')
      .order('code'),
    supabase.from('device_integrations').select('*').maybeSingle(),
    supabase
      .from('device_sync_logs')
      .select('device_id, kind, status, record_count, duration_ms, detail, started_at')
      .order('started_at', { ascending: false })
      .limit(20),
  ]);

  const devices = (deviceRes.data ?? []) as unknown as DeviceRow[];
  const codeById = new Map(devices.map((d) => [d.id, d.code]));
  const logs: SyncLogRow[] = (logRes.data ?? []).map((l) => ({
    device_code: l.device_id ? (codeById.get(l.device_id as string) ?? null) : null,
    kind: l.kind as string,
    status: l.status as string,
    record_count: Number(l.record_count),
    duration_ms: l.duration_ms === null ? null : Number(l.duration_ms),
    detail: (l.detail as string | null) ?? null,
    started_at: l.started_at as string,
  }));

  // A company with no row yet reads as an unconfigured integration rather
  // than a missing screen.
  const integration: IntegrationRow = integrationRes.data
    ? {
        endpoint_url: (integrationRes.data.endpoint_url as string | null) ?? null,
        auth_method: (integrationRes.data.auth_method as string) ?? 'api_key',
        credential_hint: (integrationRes.data.credential_hint as string | null) ?? null,
        polling_minutes: Number(integrationRes.data.polling_minutes ?? 15),
        webhook_url: (integrationRes.data.webhook_url as string | null) ?? null,
        last_full_sync_at: (integrationRes.data.last_full_sync_at as string | null) ?? null,
        last_status: (integrationRes.data.last_status as string) ?? 'unknown',
        last_error: (integrationRes.data.last_error as string | null) ?? null,
      }
    : {
        endpoint_url: null,
        auth_method: 'api_key',
        credential_hint: null,
        polling_minutes: 15,
        webhook_url: null,
        last_full_sync_at: null,
        last_status: 'unknown',
        last_error: null,
      };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">지문인식기 연동</h1>
      <p className="mt-1 text-sm text-neutral-500">
        근태 수집 장치와 API 연동 설정, 동기화 이력입니다.
      </p>

      <DevicePanel
        devices={devices}
        integration={integration}
        logs={logs}
        canEdit={EDIT_ROLES.includes(session.role)}
      />
    </main>
  );
}
