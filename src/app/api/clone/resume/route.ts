import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/jobs';
import { runCloneJob } from '@/lib/provision';
import { getCheckpoint, listResumable, reopenCheckpoint, FIRST_CONFIG_PHASE } from '@/lib/checkpoints';

// Continue a failed build on the app it already created.
//
// Re-running from scratch would clone a second Cloudways app, so resume picks
// up after the last phase that completed, and never repeats the clone.

export const dynamic = 'force-dynamic';

/** Builds that failed but still have an app attached. */
export async function GET() {
  const jobs = await listResumable();
  return NextResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      siteName: j.params.siteName,
      appId: j.appId,
      siteUrl: j.siteUrl,
      lastPhase: j.lastPhase,
      error: j.error,
      updatedAt: j.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  let jobId: string;
  try {
    jobId = String((await req.json()).jobId ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const checkpoint = await getCheckpoint(jobId);
  if (!checkpoint) {
    return NextResponse.json(
      { error: 'No checkpoint for that job — it may predate checkpointing, or the database is unavailable.' },
      { status: 404 },
    );
  }

  if (!checkpoint.appId || !checkpoint.siteUrl) {
    return NextResponse.json(
      { error: 'That build failed before the site was cloned, so there is nothing to resume. Start a new build instead.' },
      { status: 409 },
    );
  }

  if (checkpoint.status === 'running') {
    return NextResponse.json(
      { error: 'That build is still running.' },
      { status: 409 },
    );
  }

  // Never redo the clone phases, even if the checkpoint somehow recorded a
  // lower phase than the app's existence implies.
  const fromPhase = Math.max(checkpoint.lastPhase, FIRST_CONFIG_PHASE - 1);

  await reopenCheckpoint(jobId);

  const job = createJob();
  void runCloneJob(job, checkpoint.params, {
    appId: checkpoint.appId,
    siteUrl: checkpoint.siteUrl,
    fromPhase,
    checkpointId: jobId,
  });

  return NextResponse.json({ jobId: job.id, resumedFrom: fromPhase, appId: checkpoint.appId });
}
