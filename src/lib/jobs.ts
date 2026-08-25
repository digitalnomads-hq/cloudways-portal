// In-memory registry of provisioning jobs.
//
// A clone takes 10-15 minutes. Running that inside the request that started it
// means any dropped connection — proxy idle timeout, laptop sleep, tab close —
// kills the run and orphans a half-configured site. Jobs live here instead, so
// the HTTP request only carries progress and can be re-attached at any point.
//
// Single-process only: a restart loses in-flight jobs, and this will not work
// across multiple instances. That is fine for a one-instance internal portal;
// if this ever scales out, back it with Redis and keep the same interface.

export type JobStatus = 'running' | 'complete' | 'error';

export interface JobEvent {
  /** Monotonic index, used by clients to resume without gaps or duplicates. */
  seq: number;
  step: number;
  message: string;
  at: number;
}

export interface JobResult {
  siteUrl: string;
  adminUrl: string;
  cloudwaysAppId: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  events: JobEvent[];
  result?: JobResult;
  error?: string;
  /** Set as soon as the app exists, so a failed run can still be cleaned up. */
  partialAppId?: string;
  createdAt: number;
  updatedAt: number;
  /** Resolves whenever new events land, so streams wake without polling. */
  waiters: Array<() => void>;
}

const jobs = new Map<string, Job>();

// ---------------------------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------------------------
//
// Free hosting tiers spin an instance down after a period with no inbound
// requests — on Render that is 15 minutes. While a client is watching the
// progress stream its open connection counts as activity, but if the user
// closes the tab mid-build nothing else arrives and the instance can be put to
// sleep, killing a job that is 10 minutes into provisioning a real site.
//
// So while any job is running, ping our own health endpoint often enough that
// the idle timer never fires. This is scoped to active jobs deliberately: the
// app is still allowed to sleep when nothing is happening, which is what keeps
// it inside the free instance-hour allowance.

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

let activeJobs = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Public base URL of this deployment, if the platform tells us one. */
function selfUrl(): string | null {
  // RENDER_EXTERNAL_URL is injected by Render; APP_URL is the generic escape
  // hatch for anywhere else. Absent both (local dev), keep-alive is a no-op.
  return process.env.RENDER_EXTERNAL_URL ?? process.env.APP_URL ?? null;
}

function startKeepAlive(): void {
  if (keepAliveTimer) return;
  const base = selfUrl();
  if (!base) return;

  keepAliveTimer = setInterval(() => {
    fetch(`${base.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      // A failed ping is not actionable — the next one is 10 minutes away and
      // the job itself is unaffected.
    });
  }, KEEPALIVE_INTERVAL_MS);

  // Don't hold the process open on account of this timer.
  keepAliveTimer.unref?.();
}

function stopKeepAlive(): void {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

export function activeJobCount(): number {
  return activeJobs;
}

// Jobs are kept after completion so a client that reconnects late still sees the
// result. Two hours is well past any legitimate reconnect window.
const RETENTION_MS = 2 * 60 * 60 * 1000;

function pruneExpired(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.updatedAt < cutoff) jobs.delete(id);
  }
}

export function createJob(): Job {
  pruneExpired();

  const job: Job = {
    id: crypto.randomUUID(),
    status: 'running',
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    waiters: [],
  };
  jobs.set(job.id, job);

  activeJobs++;
  startKeepAlive();

  return job;
}

/**
 * Move a job out of the running state exactly once, so the active count stays
 * accurate even if a caller double-reports an outcome.
 */
function settle(job: Job, status: Exclude<JobStatus, 'running'>): boolean {
  if (job.status !== 'running') return false;
  job.status = status;
  if (--activeJobs <= 0) {
    activeJobs = 0;
    stopKeepAlive();
  }
  return true;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

function notify(job: Job): void {
  job.updatedAt = Date.now();
  const waiters = job.waiters.splice(0);
  for (const wake of waiters) wake();
}

export function appendEvent(job: Job, step: number, message: string): void {
  job.events.push({ seq: job.events.length, step, message, at: Date.now() });
  notify(job);
}

export function finishJob(job: Job, result: JobResult): void {
  if (!settle(job, 'complete')) return;
  job.result = result;
  notify(job);
}

export function failJob(job: Job, error: string): void {
  if (!settle(job, 'error')) return;
  job.error = error;
  notify(job);
}

export function setPartialAppId(job: Job, appId: string): void {
  job.partialAppId = appId;
  notify(job);
}

/**
 * Resolve once there are events past `fromSeq`, or after `timeoutMs`.
 * The timeout is what drives stream heartbeats during long quiet stretches.
 */
export function waitForUpdate(job: Job, fromSeq: number, timeoutMs: number): Promise<void> {
  if (job.events.length > fromSeq || job.status !== 'running') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    job.waiters.push(done);
  });
}
