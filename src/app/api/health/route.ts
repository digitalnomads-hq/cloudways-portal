import { NextResponse } from 'next/server';
import { activeJobCount } from '@/lib/jobs';

// Cheap, unauthenticated liveness endpoint. Used by the platform health check
// and by the in-process keep-alive that stops a free-tier instance from
// spinning down mid-build (see src/lib/jobs.ts).

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true, activeJobs: activeJobCount() });
}
