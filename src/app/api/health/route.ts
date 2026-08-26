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

// Render injects the deployed commit; the generic name is for anywhere else.
// Reported so it is possible to tell which build is actually serving, rather
// than inferring it from behaviour.
const COMMIT = (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown').slice(0, 7);

export async function GET(req: NextRequest) {
  const base = { ok: true, commit: COMMIT, activeJobs: activeJobCount() };

  if (req.nextUrl.searchParams.get('db') !== '1') {
    return NextResponse.json(base);
  }

  return NextResponse.json({ ...base, db: await dbStatus() });
}
