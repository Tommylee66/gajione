import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Next 16 renamed middleware to proxy. Session refresh happens here so every
 * server component sees a valid token; authorisation is the pages' own job,
 * and tenant isolation is the database's.
 *
 * What is added here is a home for each role. RLS already refuses an
 * employee the payroll data, but it refuses by returning nothing — so they
 * would land on an empty payroll screen and reasonably conclude it is broken,
 * rather than that it is not theirs. This sends them where their screens are.
 */
const PROTECTED_PREFIXES = ['/employees', '/org', '/payroll', '/attendance', '/shifts', '/overtime', '/policy', '/loans', '/devices', '/upload', '/reports', '/partner', '/me', '/admin'];

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
    return NextResponse.redirect(new URL(await homeFor(request), request.url));
  }

  if (user) {
    const home = await homeFor(request);
    // Only the tenant console is redirected away from. Their own area, and
    // anything shared, is left alone.
    const belongsElsewhere =
      (home === '/me' && !pathname.startsWith('/me')) ||
      (home === '/partner' && !pathname.startsWith('/partner'));
    if (belongsElsewhere) return NextResponse.redirect(new URL(home, request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};

/**
 * The landing route for the signed-in role, read from the users table rather
 * than from the token: a role change has to take effect on the next request,
 * not on the next login.
 */
async function homeFor(request: NextRequest): Promise<string> {
  const { createServerClient } = await import('@supabase/ssr');
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: () => {},
      },
    }
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return '/';
  const { data } = await supabase.from('users').select('role').eq('id', user.id).maybeSingle();
  if (data?.role === 'employee') return '/me';
  if (data?.role === 'lender_officer') return '/partner';
  return '/';
}
