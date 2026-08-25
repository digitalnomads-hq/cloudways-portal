import { NextRequest, NextResponse } from 'next/server';
import { activeJobCount } from '@/lib/jobs';
import { dbStatus } from '@/lib/db';

// Cheap, unauthenticated liveness endpoint. Used by the platform health check
// and by the in-process keep-alive that stops a free-tier instance from
// spinning down mid-build (see src/lib/jobs.ts).
//
// ?db=1 additionally reports database connectivity. That is a real round trip,
// so it is opt-in rather than part of every keep-alive ping.

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const base = { ok: true, activeJobs: activeJobCount() };

  if (req.nextUrl.searchParams.get('db') !== '1') {
    return NextResponse.json(base);
  }

  return NextResponse.json({ ...base, db: await dbStatus() });
}
