import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runDeviceSync, FAILURE_LIMIT } from '@/lib/devices/sync';

/**
 * Scheduled attendance collection.
 *
 * The device screen lets a polling interval be chosen, but an interval on its
 * own does not make anything run: something outside the request cycle has to
 * call this. Any scheduler will do — Vercel Cron, a crontab, an uptime pinger
 * — which is why this is a plain HTTP endpoint rather than a platform
 * primitive.
 *
 * Runs as the service role, because there is no signed-in user at 03:00 and
 * the job spans every tenant. That makes the shared secret the only thing
 * standing between the open internet and every company's attendance data, so
 * a missing or wrong secret refuses rather than falling back to anything.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // No secret configured means the endpoint is off, not open. A deployment
  // that forgot to set it must not quietly expose every tenant's data.
  if (!expected) return false;

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compared in constant time, and length-checked first because
  // timingSafeEqual throws on a mismatch rather than returning false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    // Deliberately uninformative: "no secret configured" and "wrong secret"
    // are the same answer to anyone asking from outside.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase service credentials missing' }, { status: 500 });
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: integrations, error } = await supabase
    .from('device_integrations')
    .select('company_id, endpoint_url, polling_minutes, last_attempt_at, consecutive_failures, auto_poll')
    .not('endpoint_url', 'is', null)
    .eq('auto_poll', true);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const results: {
    company_id: string;
    status: 'synced' | 'skipped' | 'failed' | 'suspended';
    detail?: string;
    records?: number;
  }[] = [];

  for (const i of integrations ?? []) {
    const companyId = i.company_id as string;

    // Backed off rather than retried forever. Twenty consecutive failures is
    // an endpoint that has moved, and hammering it every fifteen minutes
    // buries the sync log under identical lines nobody reads.
    if (Number(i.consecutive_failures ?? 0) >= FAILURE_LIMIT) {
      results.push({
        company_id: companyId,
        status: 'suspended',
        detail: `연속 실패 ${i.consecutive_failures}회 — 설정 확인 후 수동 동기화로 재개`,
      });
      continue;
    }

    // Due when the interval has elapsed since the last attempt. A minute of
    // slack, because a scheduler firing at :00 and an attempt recorded at
    // :00:03 would otherwise be a minute short every single tick.
    const last = i.last_attempt_at ? Date.parse(i.last_attempt_at as string) : 0;
    const dueAt = last + Number(i.polling_minutes) * 60_000 - 60_000;
    if (now < dueAt) {
      results.push({ company_id: companyId, status: 'skipped', detail: '아직 주기 전' });
      continue;
    }

    // One tenant's failure must not stop the rest of the loop.
    try {
      const outcome = await runDeviceSync(supabase, companyId, null);
      results.push(
        outcome.ok
          ? { company_id: companyId, status: 'synced', records: outcome.records }
          : { company_id: companyId, status: 'failed', detail: outcome.error }
      );
    } catch (e) {
      results.push({
        company_id: companyId,
        status: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    considered: (integrations ?? []).length,
    synced: results.filter((r) => r.status === 'synced').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  });
}
