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

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const res = await fetch(`${API_BASE}/oauth/access_token`, {
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

/** Clone the template app on the same server. */
export async function cloneApp(newLabel: string): Promise<void> {
  const token = await getAccessToken();

  const res = await fetch(`${API_BASE}/app/clone`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      server_id: process.env.CLOUDWAYS_SERVER_ID!,
      app_id: process.env.CLOUDWAYS_TEMPLATE_APP_ID!,
      app_label: newLabel,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clone request failed (${res.status}): ${text}`);
  }

  // Response includes an operation object but the operation polling endpoint
  // requires app-level auth — instead we poll the app list (see waitForClone).
}

/**
 * Wait until a cloned app appears in the server's app list.
 * More reliable than polling the operation endpoint directly.
 */
export async function waitForClone(
  appLabel: string,
  onProgress?: (message: string) => void,
  intervalMs = 10000,
  timeoutMs = 15 * 60 * 1000,
): Promise<CloudwaysApp> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempts++;

    const app = await findAppByLabel(appLabel);
    if (app) return app;

    const elapsed = Math.round((attempts * intervalMs) / 1000);
    onProgress?.(`Waiting for clone to provision… (${elapsed}s)`);
  }

  throw new Error('Timed out waiting for clone to appear — check Cloudways dashboard.');
}

/**
 * Poll a Cloudways operation by ID until is_completed === "1".
 * Used for service operations (e.g. Nginx restart) where we do have the op ID.
 */
export async function waitForOperation(
  operationId: string,
  onProgress?: (message: string) => void,
  intervalMs = 3000,
  timeoutMs = 60000,
): Promise<void> {
  const token = await getAccessToken();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const res = await fetch(`${API_BASE}/operation/${operationId}`, {
      headers: authHeaders(token),
    });

    if (!res.ok) {
      // Operation endpoint can be unreliable — fall back to fixed wait
      onProgress?.('Waiting for operation…');
      await sleep(5000);
      return;
    }

    const data = await res.json();
    const op = data.operation ?? data;

    // Cloudways uses is_completed: "0" / "1" (strings)
    if (op?.is_completed === '1' || op?.status === 1) return;
    if (op?.is_failed === '1' || op?.status === -1) {
      throw new Error(`Operation ${operationId} failed`);
    }

    onProgress?.(`${op?.status ?? 'In progress'}…`);
  }

  // Timed out — not fatal for service restarts, just continue
}

/**
 * Restart Nginx via the Cloudways API, then confirm the site is reachable.
 * Endpoint: POST /service  { server_id, service_type: "nginx", state: "restart" }
 * Returns an operation ID which we poll until complete.
 */
export async function restartNginxAndWait(
  siteUrl: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  onProgress?.('Restarting Nginx via Cloudways API…');

  try {
    const token = await getAccessToken();

    const res = await fetch(`${API_BASE}/service/state`, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        server_id: process.env.CLOUDWAYS_SERVER_ID!,
        service: 'nginx',
        state: 'restart',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      onProgress?.(`Nginx restart API call failed (${res.status}: ${text}) — will poll until site responds.`);
    } else {
      const data = await res.json();
      const operationId = data.operation_id ?? data.operation?.id;
      if (operationId) {
        onProgress?.('Nginx restart triggered — waiting for operation to complete…');
        await waitForOperation(String(operationId), onProgress, 3000, 60000);
        onProgress?.('Nginx restarted.');
      } else {
        onProgress?.('Nginx restart triggered.');
      }
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
  let attempts = 0;

  onProgress?.(`Waiting for site to be reachable…`);

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempts++;

    try {
      const res = await fetch(siteUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.status > 0) {
        onProgress?.(`Site is reachable (HTTP ${res.status}).`);
        return;
      }
    } catch {
      // Not up yet — keep polling
    }

    const elapsed = Math.round((attempts * intervalMs) / 1000);
    onProgress?.(`Not reachable yet, retrying… (${elapsed}s)`);
  }

  throw new Error(`Site at ${siteUrl} did not become reachable within ${timeoutMs / 1000}s.`);
}

/** Find an app on the template server by label. */
export async function findAppByLabel(label: string): Promise<CloudwaysApp | null> {
  const token = await getAccessToken();

  const res = await fetch(`${API_BASE}/server?server_id=${encodeURIComponent(process.env.CLOUDWAYS_SERVER_ID!)}`, {
    headers: authHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get server failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Response can be { server: {...} } or { servers: [...] }
  const servers: CloudwaysServer[] = data.servers ?? (data.server ? [data.server] : []);
  const server = servers.find((s) => s.id === process.env.CLOUDWAYS_SERVER_ID) ?? servers[0];
  if (!server) throw new Error('Template server not found');

  return server.apps?.find((a) => a.label === label) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
