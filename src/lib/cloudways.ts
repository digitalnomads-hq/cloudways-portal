import { fetchWithRetry, fetchOnce } from './http';

const API_BASE = 'https://api.cloudways.com/api/v1';

export interface CloudwaysApp {
  id: string;
  label: string;
  application: string;
  app_version: string;
  cname: string;
  app_fqdn: string;
  is_ssl: string;
  sys_user: string; // Cloudways-generated username — used to derive the WP path on disk
}

export interface CloudwaysServer {
  id: string;
  label: string;
  apps: CloudwaysApp[];
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const res = await fetchWithRetry(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: process.env.CLOUDWAYS_EMAIL!,
      api_key: process.env.CLOUDWAYS_API_KEY!,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudways auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Tokens expire after ~3600s; cache for 55 minutes to be safe
  cachedToken = { value: data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return cachedToken.value;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Authenticated Cloudways request that transparently re-auths once on 401.
 * A clone can run well past the token lifetime, so a mid-run expiry is normal
 * rather than exceptional.
 */
async function cwFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const withAuth = (t: string): RequestInit => ({
    ...init,
    headers: { ...authHeaders(t), ...(init.headers as Record<string, string>) },
  });

  let res = await fetchWithRetry(`${API_BASE}${path}`, withAuth(token));

  if (res.status === 401) {
    const fresh = await getAccessToken(true);
    res = await fetchWithRetry(`${API_BASE}${path}`, withAuth(fresh));
  }

  return res;
}

/**
 * Clone the template app on the same server.
 *
 * Deliberately not retried: a retried clone that actually succeeded the first
 * time would leave a duplicate app behind, which is worse than surfacing the
 * error.
 */
export async function cloneApp(newLabel: string, sourceAppId?: string): Promise<void> {
  const token = await getAccessToken();

  const res = await fetchOnce(`${API_BASE}/app/clone`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      server_id: process.env.CLOUDWAYS_SERVER_ID!,
      app_id: sourceAppId ?? process.env.CLOUDWAYS_TEMPLATE_APP_ID!,
      app_label: newLabel,
    }),
  }, 60000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clone request failed (${res.status}): ${text}`);
  }

  // Response includes an operation object but the operation polling endpoint
  // requires app-level auth — instead we poll the app list (see waitForClone).
}

/**
 * Wait until a cloned app appears in the server's app list.
 *
 * Transient API failures are tolerated: Cloudways returns 502/429 under load,
 * and letting one of those escape would abort a clone that is already running
 * on their side — orphaning the app. Only a sustained failure run gives up.
 */
export async function waitForClone(
  appLabel: string,
  onProgress?: (message: string) => void,
  options: { excludeAppIds?: Set<string>; intervalMs?: number; timeoutMs?: number } = {},
): Promise<CloudwaysApp> {
  const { excludeAppIds, intervalMs = 10000, timeoutMs = 15 * 60 * 1000 } = options;
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const app = await findAppByLabel(appLabel);
      // Only accept an app that did not exist before we started. A leftover app
      // from an earlier failed run shares the label, and matching it would mean
      // silently reconfiguring the wrong site.
      if (app && !excludeAppIds?.has(app.id)) return app;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      const reason = err instanceof Error ? err.message : String(err);
      // 5 consecutive failures (~50s of a dead API) means something is actually
      // wrong, not a blip.
      if (consecutiveErrors >= 5) {
        throw new Error(`Cloudways API unreachable while waiting for clone: ${reason}`);
      }
      onProgress?.(`Cloudways API error (${reason.slice(0, 80)}) — retrying…`);
    }

    await sleep(intervalMs);
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress?.(`Waiting for clone to provision… (${elapsed}s)`);
  }

  throw new Error('Timed out waiting for clone to appear — check Cloudways dashboard.');
}

export type OperationResult = 'completed' | 'timeout' | 'unknown';

/**
 * Poll a Cloudways operation by ID until is_completed === "1".
 *
 * Returns how the wait actually ended rather than conflating "completed" with
 * "gave up" — callers decide whether an inconclusive result is fatal.
 */
export async function waitForOperation(
  operationId: string,
  onProgress?: (message: string) => void,
  intervalMs = 3000,
  timeoutMs = 60000,
): Promise<OperationResult> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let res: Response;
    try {
      res = await cwFetch(`/operation/${operationId}`);
    } catch {
      if (++consecutiveErrors >= 5) return 'unknown';
      continue;
    }

    if (!res.ok) {
      if (++consecutiveErrors >= 5) return 'unknown';
      onProgress?.('Waiting for operation…');
      continue;
    }

    consecutiveErrors = 0;
    const data = await res.json();
    const op = data.operation ?? data;

    // Cloudways uses is_completed: "0" / "1" (strings)
    if (op?.is_completed === '1' || op?.status === 1) return 'completed';
    if (op?.is_failed === '1' || op?.status === -1) {
      throw new Error(`Operation ${operationId} failed`);
    }

    onProgress?.(`${op?.status ?? 'In progress'}…`);
  }

  return 'timeout';
}

/**
 * Restart Nginx via the Cloudways API, then confirm the site is reachable.
 * Endpoint: POST /service/state { server_id, service, state }
 */
export async function restartNginxAndWait(
  siteUrl: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  onProgress?.('Restarting Nginx via Cloudways API…');

  const MAX_RESTART_ATTEMPTS = 3;

  try {
    // A 422 means another operation holds the server lock. Wait it out and try
    // again — but bounded, so a permanently stuck server can't stall the run.
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
      const res = await cwFetch('/service/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          server_id: process.env.CLOUDWAYS_SERVER_ID!,
          service: 'nginx',
          state: 'restart',
        }),
      });

      if (res.status === 422 && attempt < MAX_RESTART_ATTEMPTS) {
        const data = await res.json().catch(() => ({}));
        const blockingOpId = data.operation?.id;
        if (blockingOpId) {
          onProgress?.('Waiting for ongoing operation to finish before restarting Nginx…');
          await waitForOperation(String(blockingOpId), onProgress, 5000, 5 * 60 * 1000);
          onProgress?.(`Retrying Nginx restart (attempt ${attempt + 1}/${MAX_RESTART_ATTEMPTS})…`);
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        onProgress?.(`Nginx restart API call failed (${res.status}: ${text.slice(0, 120)}) — will poll until site responds.`);
      } else {
        const data = await res.json().catch(() => ({}));
        const status = data.service_status?.status;
        onProgress?.(`Nginx restarted${status ? ` (${status})` : ''}.`);
      }
      break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Nginx restart failed (${msg}) — will poll until site responds.`);
  }

  // Always confirm the site is actually reachable before continuing
  await waitForSiteReachable(siteUrl, onProgress);
}

async function waitForSiteReachable(
  siteUrl: string,
  onProgress?: (message: string) => void,
  intervalMs = 8000,
  timeoutMs = 3 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  onProgress?.('Waiting for site to be reachable…');

  while (Date.now() < deadline) {
    try {
      const res = await fetch(siteUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.status > 0) {
        onProgress?.(`Site is reachable (HTTP ${res.status}).`);
        return;
      }
    } catch {
      // Not up yet — keep polling
    }

    await sleep(intervalMs);
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress?.(`Not reachable yet, retrying… (${elapsed}s)`);
  }

  throw new Error(`Site at ${siteUrl} did not become reachable within ${timeoutMs / 1000}s.`);
}

/**
 * Wait until the cloned site's WordPress REST API answers.
 *
 * Nginx answering is not the same as WordPress being ready — the app record
 * appears in the API before the file copy and DB import finish, so the REST
 * endpoint is the only honest readiness signal. Without this the branding and
 * page-creation steps race the import and fail intermittently.
 */
export async function waitForWordPressReady(
  siteUrl: string,
  onProgress?: (message: string) => void,
  intervalMs = 8000,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  onProgress?.('Waiting for WordPress to finish importing…');

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/types`, {
        signal: AbortSignal.timeout(10000),
      });
      // 200 means REST is live. 401/403 also prove WP is answering — the route
      // exists and is merely refusing anonymous access.
      if (res.ok || res.status === 401 || res.status === 403) {
        onProgress?.('WordPress REST API is responding.');
        return;
      }
    } catch {
      // Still importing — keep polling
    }

    await sleep(intervalMs);
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress?.(`WordPress not ready yet… (${elapsed}s)`);
  }

  throw new Error(`WordPress REST API at ${siteUrl} did not respond within ${timeoutMs / 1000}s.`);
}

/** List every app on the template server. */
export async function listApps(): Promise<CloudwaysApp[]> {
  const res = await cwFetch(`/server?server_id=${encodeURIComponent(process.env.CLOUDWAYS_SERVER_ID!)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get server failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Response can be { server: {...} } or { servers: [...] }
  const servers: CloudwaysServer[] = data.servers ?? (data.server ? [data.server] : []);
  const server = servers.find((s) => s.id === process.env.CLOUDWAYS_SERVER_ID) ?? servers[0];
  if (!server) throw new Error('Template server not found');

  return server.apps ?? [];
}

/** Find an app on the template server by label. */
export async function findAppByLabel(label: string): Promise<CloudwaysApp | null> {
  const apps = await listApps();
  return apps.find((a) => a.label === label) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
