import { query, tryQuery, isDbConfigured } from './db';
import type { CloneParams } from './provision';

// Durable checkpoints for provisioning jobs.
//
// The in-memory job registry (src/lib/jobs.ts) tracks a run while it is
// happening; this records how far it got, so a failed build can be picked up
// where it stopped instead of being re-run from scratch. That matters most
// because the expensive, non-repeatable phase is the clone itself — re-running
// a failed build from the top would create a second Cloudways app.

/**
 * Pipeline phases, in order. `last_phase` stores the highest one that finished,
 * so a resume runs everything after it.
 */
export const PHASE = {
  PREFLIGHT: 1,
  PLUGIN_CHECK: 2,
  CLONE: 3,
  WAIT_APP: 4,
  SITE_READY: 5,
  BRANDING: 6,
  CLEANUP: 7,
  PAGES: 8,
  SETTINGS: 9,
  MENU_PLUGINS: 10,
  EMAIL: 11,
} as const;

/** The first phase that operates on the cloned site rather than creating it. */
export const FIRST_CONFIG_PHASE = PHASE.BRANDING;

export interface Checkpoint {
  id: string;
  status: 'running' | 'complete' | 'error';
  params: CloneParams;
  appId: string | null;
  siteUrl: string | null;
  lastPhase: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  status: 'running' | 'complete' | 'error';
  params: Omit<CloneParams, 'logo' | 'favicon'>;
  logo: Buffer | null;
  logo_name: string | null;
  logo_mime: string | null;
  favicon: Buffer | null;
  favicon_name: string | null;
  favicon_mime: string | null;
  app_id: string | null;
  site_url: string | null;
  last_phase: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Persist a job at creation. Files are stored inline: logos and favicons are
 * small, and without them a resume could not redo the branding phase.
 */
export async function createCheckpoint(id: string, params: CloneParams): Promise<void> {
  if (!isDbConfigured()) return;

  // Strip the buffers out of the JSON payload — they go in their own columns.
  const { logo, favicon, ...rest } = params;

  await query(
    `INSERT INTO jobs (id, status, params, logo, logo_name, logo_mime, favicon, favicon_name, favicon_mime)
     VALUES ($1, 'running', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      JSON.stringify(rest),
      logo?.buffer ?? null,
      logo?.filename ?? null,
      logo?.mimeType ?? null,
      favicon?.buffer ?? null,
      favicon?.filename ?? null,
      favicon?.mimeType ?? null,
    ],
  );
}

/** Record that a phase finished. Never regresses last_phase on a resume. */
export async function markPhase(id: string, phase: number): Promise<void> {
  if (!isDbConfigured()) return;
  await query(
    `UPDATE jobs SET last_phase = GREATEST(last_phase, $2), updated_at = now() WHERE id = $1`,
    [id, phase],
  );
}

/** Record the cloned app as soon as it exists, so a resume can find it. */
export async function attachApp(id: string, appId: string, siteUrl: string): Promise<void> {
  if (!isDbConfigured()) return;
  await query(
    `UPDATE jobs SET app_id = $2, site_url = $3, updated_at = now() WHERE id = $1`,
    [id, appId, siteUrl],
  );
}

/** Put a failed checkpoint back into the running state for a resume. */
export async function reopenCheckpoint(id: string): Promise<void> {
  if (!isDbConfigured()) return;
  await query(
    `UPDATE jobs SET status = 'running', error = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function closeCheckpoint(
  id: string,
  status: 'complete' | 'error',
  error?: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await query(
    `UPDATE jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error ?? null],
  );
}

export async function getCheckpoint(id: string): Promise<Checkpoint | null> {
  const rows = await tryQuery<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  if (!rows || rows.length === 0) return null;

  const r = rows[0];
  const params: CloneParams = {
    ...r.params,
    logo: r.logo
      ? { buffer: r.logo, filename: r.logo_name ?? 'logo.png', mimeType: r.logo_mime ?? 'image/png' }
      : null,
    favicon: r.favicon
      ? { buffer: r.favicon, filename: r.favicon_name ?? 'favicon.png', mimeType: r.favicon_mime ?? 'image/png' }
      : null,
  };

  return {
    id: r.id,
    status: r.status,
    params,
    appId: r.app_id,
    siteUrl: r.site_url,
    lastPhase: r.last_phase,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Failed jobs that still have a cloned app attached — the resumable ones. */
export async function listResumable(): Promise<Checkpoint[]> {
  const rows = await tryQuery<JobRow>(
    `SELECT * FROM jobs
     WHERE status = 'error' AND app_id IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 25`,
  );
  if (!rows) return [];

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    params: { ...r.params, logo: null, favicon: null } as CloneParams,
    appId: r.app_id,
    siteUrl: r.site_url,
    lastPhase: r.last_phase,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}
