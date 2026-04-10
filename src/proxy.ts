import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get('portal_auth')?.value;
  const expected = expectedToken();

  if (!expected) {
    return new NextResponse('PORTAL_SECRET is not set in environment variables.', { status: 503 });
  }

  if (cookie !== expected) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

/**
 * PORTAL_SECRET is the session token stored in the cookie.
 * The login page checks PORTAL_PASSWORD; on success it sets the cookie to this value.
 * Change PORTAL_SECRET to invalidate all existing sessions.
 */
export function expectedToken(): string | null {
  return process.env.PORTAL_SECRET ?? null;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
