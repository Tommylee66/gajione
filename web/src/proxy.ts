import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Next 16 renamed middleware to proxy. Session refresh happens here so every
 * server component sees a valid token; authorisation is the pages' own job,
 * and tenant isolation is the database's.
 */
const PROTECTED_PREFIXES = ['/employees', '/org', '/payroll', '/attendance', '/shifts', '/overtime', '/policy', '/loans', '/devices', '/upload', '/reports', '/partner', '/admin'];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // '/' is the payroll home, so it is listed exactly rather than as a
  // prefix — every path starts with '/'.
  const isProtected = pathname === '/' || PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthRoute = pathname.startsWith('/login');

  if (!isProtected && !isAuthRoute) return NextResponse.next();

  const { supabaseResponse, user } = await updateSession(request);

  if (isProtected && !user) {
    const url = new URL('/login', request.url);
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }
  if (isAuthRoute && user) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
