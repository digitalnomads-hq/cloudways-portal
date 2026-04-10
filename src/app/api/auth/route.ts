import { NextRequest, NextResponse } from 'next/server';
import { expectedToken } from '@/proxy';

export async function POST(req: NextRequest) {
  const { password } = await req.json();

  if (!password) {
    return NextResponse.json({ error: 'Password required' }, { status: 400 });
  }

  const token = expectedToken();

  if (!token) {
    return NextResponse.json({ error: 'Server misconfigured — PORTAL_SECRET not set' }, { status: 503 });
  }

  if (password !== process.env.PORTAL_PASSWORD) {
    // Small delay to slow brute-force attempts
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set('portal_auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
