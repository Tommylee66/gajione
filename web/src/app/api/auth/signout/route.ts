import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Sign out.
 *
 * POST only: a GET would let any page on the internet log somebody out with an
 * <img> tag, which is a nuisance rather than a breach but an avoidable one.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
}
