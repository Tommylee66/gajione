'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  updateIntegrationAction,
  syncDevicesAction,
  saveDeviceAction,
} from '@/app/devices/actions';

const input =
  'mt-1 block rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950';
const primary =
  'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';

export interface DeviceRow {
  id: string;
  code: string;
  name: string | null;
  device_type: string;
  location: string | null;
  status: string;
  last_sync_at: string | null;
}

export interface IntegrationRow {
  endpoint_url: string | null;
  auth_method: string;
  credential_hint: string | null;
  polling_minutes: number;
  webhook_url: string | null;
  last_full_sync_at: string | null;
  last_status: string;
  last_error: string | null;
}

export interface SyncLogRow {
  device_code: string | null;
  kind: string;
  status: string;
  record_count: number;
  duration_ms: number | null;
  detail: string | null;
  started_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  fingerprint: '지문인식기',
  mobile: '모바일 GPS',
  card: '카드',
  face: '안면인식',
};

const STATUS_LABELS: Record<string, string> = {
  active: '온라인',
  offline: '오프라인',
  retired: '사용중지',
};

function time(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function DevicePanel({
  devices,
  integration,
  logs,
  canEdit,
}: {
  devices: DeviceRow[];
  integration: IntegrationRow;
  logs: SyncLogRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; records?: number }>, ok: string) {
    setBusy(true);
    setNote(null);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? '처리에 실패했습니다.');
    else setNote(r.records !== undefined ? `${r.records}건 수집했습니다.` : ok);
    router.refresh();
  }

  const online = devices.filter((d) => d.status === 'active').length;
  const usable = devices.filter((d) => d.status !== 'retired').length;

  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="연결된 장치" value={`${online}/${usable}`} />
        <Stat label="마지막 전체 동기화" value={time(integration.last_full_sync_at)} />
        <Stat label="폴링 주기" value={`${integration.polling_minutes}분`} />
        <Stat
          label="API 상태"
          value={
            integration.last_status === 'ok'
              ? '정상'
              : integration.last_status === 'failed'
                ? '오류'
                : '미확인'
          }
          sub={integration.last_error ?? undefined}
        />
      </section>

      <p className="mt-4 text-sm text-neutral-500">
        여기서 수집된 근태가 근태 마감(G1)의 소스가 되고, 급여 계산(G2)에 반영됩니다.{' '}
        <Link href="/attendance" className="text-blue-600 underline">
          근태 마감 보기 →
        </Link>
      </p>

      {note && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{note}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* --- 연결된 장치 ---------------------------------------------------- */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">연결된 장치</h2>
          <div className="flex gap-2">
            {canEdit && (
              <button
                onClick={() => setAdding((v) => !v)}
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
              >
                {adding ? '닫기' : '+ 장치 추가'}
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => run(() => syncDevicesAction(null), '전체 동기화했습니다.')}
              className={primary}
            >
              지금 전체 동기화
            </button>
          </div>
        </div>

        {adding && <DeviceForm onDone={() => setAdding(false)} onRun={run} busy={busy} />}

        {devices.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">등록된 장치가 없습니다.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">장치명</th>
                  <th className="px-3 py-2 font-medium">위치</th>
                  <th className="px-3 py-2 font-medium">장치ID</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">마지막 동기화</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">
                      {d.name ?? d.code}
                      <span className="ml-2 text-xs text-neutral-500">
                        {TYPE_LABELS[d.device_type] ?? d.device_type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {d.location ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{d.code}</td>
                    <td className="px-3 py-2">
                      <span className={d.status === 'active' ? '' : 'text-red-600'}>
                        {STATUS_LABELS[d.status] ?? d.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{time(d.last_sync_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        disabled={busy || d.status === 'retired'}
                        onClick={() => run(() => syncDevicesAction(d.id), '동기화했습니다.')}
                        className="text-sm text-blue-600 underline disabled:opacity-50"
                      >
                        지금 동기화
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- API 연동 설정 --------------------------------------------------- */}
      <IntegrationForm integration={integration} canEdit={canEdit} onRun={run} busy={busy} />

      {/* --- 동기화 로그 ----------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">동기화 로그</h2>
        {/* Failures are kept, not just successes. "The device was offline that
            morning" is the answer to a missing punch, and it can only be given
            if the failure was recorded when it happened. */}
        <p className="mt-1 text-sm text-neutral-500">
          실패한 시도도 남습니다. 누락된 근태의 원인을 나중에 확인하려면 그때의 기록이 있어야
          합니다.
        </p>
        {logs.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">기록된 동기화가 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {logs.map((l, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-xs text-neutral-500">{time(l.started_at)}</span>
                <span>
                  {l.kind === 'full' ? '전체 동기화' : `${l.device_code ?? '장치'} 개별 동기화`}
                </span>
                <span className="text-neutral-600 dark:text-neutral-400">{l.detail ?? '—'}</span>
                <span
                  className={
                    l.status === 'success'
                      ? 'text-neutral-500'
                      : l.status === 'partial'
                        ? 'text-amber-600'
                        : 'text-red-600'
                  }
                >
                  {l.status === 'success' ? '성공' : l.status === 'partial' ? '부분 성공' : '실패'}
                  {l.duration_ms !== null && ` · ${l.duration_ms}ms`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- 데이터 흐름 ----------------------------------------------------- */}
      <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-base font-semibold">데이터 흐름</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          지문인식기 · 모바일 GPS → API 폴링({integration.polling_minutes}분마다) → 근태 레코드
          갱신 → 근태 마감(G1) → 급여 계산(G2)
        </p>
        {/* Stated because the screen's buttons are manual pulls. A scheduled
            poll needs something outside the request cycle to run it. */}
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
          ⚠️ 현재는 이 화면의 버튼으로 수동 수집만 합니다. {integration.polling_minutes}분 주기
          자동 폴링은 별도 스케줄러(cron) 연결이 필요합니다.
        </p>
      </section>
    </>
  );
}

function IntegrationForm({
  integration,
  canEdit,
  onRun,
  busy,
}: {
  integration: IntegrationRow;
  canEdit: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  busy: boolean;
}) {
  const [endpoint, setEndpoint] = useState(integration.endpoint_url ?? '');
  const [auth, setAuth] = useState(integration.auth_method);
  const [credential, setCredential] = useState('');
  const [polling, setPolling] = useState(integration.polling_minutes);
  const [webhook, setWebhook] = useState(integration.webhook_url ?? '');

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">API 연동 설정</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-xs text-neutral-500">엔드포인트 URL (https)</span>
          <input
            value={endpoint}
            disabled={!canEdit}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://device-gateway.example.com/api/punches"
            className={`${input} w-full`}
          />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">인증 방식</span>
          <select
            value={auth}
            disabled={!canEdit}
            onChange={(e) => setAuth(e.target.value)}
            className={`${input} w-full`}
          >
            <option value="api_key">API Key</option>
            <option value="oauth2">OAuth 2.0</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">
            인증정보{' '}
            {integration.credential_hint && (
              <span className="text-neutral-400">
                (저장됨 · ••••{integration.credential_hint})
              </span>
            )}
          </span>
          {/* Never rendered back. The stored value is shown only as its last
              four characters, and an empty box leaves it untouched. */}
          <input
            type="password"
            value={credential}
            disabled={!canEdit}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={integration.credential_hint ? '변경할 때만 입력' : '입력'}
            className={`${input} w-full`}
          />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">폴링 주기</span>
          <select
            value={polling}
            disabled={!canEdit}
            onChange={(e) => setPolling(Number(e.target.value))}
            className={`${input} w-full`}
          >
            {[5, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">Webhook URL (대안)</span>
          <input
            value={webhook}
            disabled={!canEdit}
            onChange={(e) => setWebhook(e.target.value)}
            className={`${input} w-full`}
          />
        </label>
      </div>
      {canEdit && (
        <button
          disabled={busy}
          onClick={() =>
            onRun(
              () =>
                updateIntegrationAction({
                  endpointUrl: endpoint,
                  authMethod: auth as 'api_key' | 'oauth2',
                  credential,
                  pollingMinutes: polling,
                  webhookUrl: webhook,
                }),
              '저장했습니다.'
            )
          }
          className={`mt-3 ${primary}`}
        >
          저장
        </button>
      )}
    </section>
  );
}

function DeviceForm({
  onDone,
  onRun,
  busy,
}: {
  onDone: () => void;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'fingerprint' | 'mobile' | 'card' | 'face'>('fingerprint');
  const [location, setLocation] = useState('');

  return (
    <div className="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="text-xs text-neutral-500">장치ID</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="FP-A01" className={`${input} w-full font-mono`} />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">장치명</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="지문기 A-1" className={`${input} w-full`} />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">유형</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            className={`${input} w-full`}
          >
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">위치</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="A동 1-6호실" className={`${input} w-full`} />
        </label>
      </div>
      <div className="mt-3 flex gap-3">
        <button
          disabled={busy}
          onClick={() =>
            onRun(
              () =>
                saveDeviceAction({ code, name, deviceType: type, location, status: 'active' }).then(
                  (r) => (r.ok ? (onDone(), r) : r)
                ),
              '장치를 추가했습니다.'
            )
          }
          className={primary}
        >
          추가
        </button>
        <button onClick={onDone} className="text-sm text-neutral-500 underline">
          취소
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-red-600">{sub}</p>}
    </div>
  );
}
