import { NextRequest, NextResponse } from 'next/server';
import { getJob, waitForUpdate } from '@/lib/jobs';

// Resumable progress stream for a provisioning job.
//
// GET /api/clone/stream?jobId=<id>&from=<seq>
//
// Replays every event from `from` onward, then streams new ones live. Because
// events carry a monotonic seq and the job outlives the request, a client that
// drops can reconnect with the last seq it saw and continue without gaps.

export const dynamic = 'force-dynamic';

// Emitted during quiet stretches so intermediaries don't treat the connection
// as idle and close it. SSE comment lines are ignored by parsers.
const HEARTBEAT_MS = 15000;

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  const from = Number(req.nextUrl.searchParams.get('from') ?? '0') || 0;

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Unknown or expired job' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let cursor = from;

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client went away — stop writing, but leave the job running.
          open = false;
        }
      };

      // Abort promptly when the client disconnects rather than looping until
      // the job ends.
      req.signal.addEventListener('abort', () => { open = false; });

      while (open) {
        // Drain everything already recorded.
        while (cursor < job.events.length) {
          const ev = job.events[cursor++];
          write(sseEvent({ event: 'status', seq: ev.seq, step: ev.step, message: ev.message }));
        }

        if (job.status === 'complete') {
          write(sseEvent({ event: 'complete', message: 'Site is ready!', ...job.result }));
          break;
        }

        if (job.status === 'error') {
          write(sseEvent({ event: 'error', message: job.error, cloudwaysAppId: job.partialAppId }));
          break;
        }

        await waitForUpdate(job, cursor, HEARTBEAT_MS);
        if (job.events.length === cursor && job.status === 'running') {
          write(': keepalive\n\n');
        }
      }

      open = false;
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which would defeat SSE.
      'X-Accel-Buffering': 'no',
    },
  });
}
