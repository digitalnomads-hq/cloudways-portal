import { Pool } from 'pg';

// Postgres-backed persistence for the shared site registry and for job
// checkpoints (which make a failed build resumable).
//
// DATABASE_URL is optional. Without it the app still runs — the registry falls
// back to reading live from the Cloudways API and resume is unavailable — so
// local development and a fresh deploy work before the database exists.

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  pool = new Pool({
    connectionString,
    // Managed Postgres (Render, Neon, Supabase) terminates non-TLS connections.
    // The certs are not in Node's trust store, so verification is disabled —
    // the connection is still encrypted.
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', () => {
    // An idle client erroring out is recoverable — the pool replaces it. Without
    // a handler, Node treats it as an unhandled error and kills the process.
  });

  return pool;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sites (
    app_id        TEXT PRIMARY KEY,
    site_name     TEXT NOT NULL,
    site_url      TEXT NOT NULL,
    admin_url     TEXT NOT NULL,
    template_id   TEXT,
    template_name TEXT,
    primary_color TEXT,
    indexing      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    params          JSONB NOT NULL,
    logo            BYTEA,
    logo_name       TEXT,
    logo_mime       TEXT,
    favicon         BYTEA,
    favicon_name    TEXT,
    favicon_mime    TEXT,
    app_id          TEXT,
    site_url        TEXT,
    last_phase      INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, updated_at DESC);
`;

/** Create tables on first use. Idempotent, and only ever runs once per process. */
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        // Let the next call retry rather than caching a failed init.
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

/** Run a query, initialising the schema first. Throws if DATABASE_URL is unset. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const res = await getPool().query(text, values);
  return res.rows as T[];
}

export type DbStatus =
  | { state: 'not-configured' }
  | { state: 'ok' }
  | { state: 'error'; message: string };

/**
 * Report whether the database is usable, distinguishing "no DATABASE_URL" from
 * "configured but failing". The read paths deliberately swallow errors to stay
 * available, which otherwise makes a broken connection look identical to an
 * absent one.
 */
export async function dbStatus(): Promise<DbStatus> {
  if (!isDbConfigured()) return { state: 'not-configured' };
  try {
    await query('SELECT 1');
    return { state: 'ok' };
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run a query, returning null instead of throwing when the database is absent
 * or unreachable. Used on read paths where a degraded view beats an error page.
 */
export async function tryQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[] | null> {
  if (!isDbConfigured()) return null;
  try {
    return await query<T>(text, values);
  } catch {
    return null;
  }
}
