import { NextResponse } from 'next/server';
import { isSshConfigured, testSshConnection } from '@/lib/ssh';

const API_BASE = 'https://api.cloudways.com/api/v1';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkCloudwaysAuth(): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const email = process.env.CLOUDWAYS_EMAIL;
  const apiKey = process.env.CLOUDWAYS_API_KEY;

  if (!email || !apiKey) {
    return { ok: false, message: 'CLOUDWAYS_EMAIL or CLOUDWAYS_API_KEY is not set in .env.local' };
  }

  const res = await fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, api_key: apiKey }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `Auth failed (${res.status}): ${text}` };
  }

  const data = await res.json();
  const token: string = data.access_token;
  if (!token) return { ok: false, message: 'No access_token in response' };

  return { ok: true, token };
}

async function checkServer(
  token: string,
): Promise<{ ok: true; serverLabel: string; apps: { id: string; label: string; cname: string }[] } | { ok: false; message: string }> {
  const serverId = process.env.CLOUDWAYS_SERVER_ID;

  if (!serverId) return { ok: false, message: 'CLOUDWAYS_SERVER_ID is not set in .env.local' };

  const res = await fetch(`${API_BASE}/server`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `Server list failed (${res.status}): ${text}` };
  }

  const data = await res.json();
  const servers: { id: string; label: string; apps: { id: string; label: string; cname: string }[] }[] =
    data.servers ?? [];

  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    const ids = servers.map((s) => `${s.label} (${s.id})`).join(', ');
    return {
      ok: false,
      message: `Server ID "${serverId}" not found. Available servers: ${ids || 'none'}`,
    };
  }

  return { ok: true, serverLabel: server.label, apps: server.apps ?? [] };
}

async function checkTemplateApp(
  apps: { id: string; label: string; cname: string; app_fqdn?: string }[],
): Promise<{ ok: true; appLabel: string; appUrl: string } | { ok: false; message: string }> {
  const appId = process.env.CLOUDWAYS_TEMPLATE_APP_ID;

  if (!appId) return { ok: false, message: 'CLOUDWAYS_TEMPLATE_APP_ID is not set in .env.local' };

  const app = apps.find((a) => a.id === appId);
  if (!app) {
    const ids = apps.map((a) => `${a.label} (${a.id})`).join(', ');
    return {
      ok: false,
      message: `App ID "${appId}" not found on server. Apps on this server: ${ids || 'none'}`,
    };
  }

  const appUrl = app.app_fqdn ? `https://${app.app_fqdn}` : `http://${app.cname}`;
  return { ok: true, appLabel: app.label, appUrl };
}

async function checkWordPress(
  appUrl: string,
): Promise<{ ok: true; siteTitle: string; wpVersion?: string } | { ok: false; message: string }> {
  const username = process.env.TEMPLATE_WP_USERNAME;
  const appPassword = process.env.TEMPLATE_WP_APP_PASSWORD;

  if (!username || !appPassword) {
    return { ok: false, message: 'TEMPLATE_WP_USERNAME or TEMPLATE_WP_APP_PASSWORD is not set in .env.local' };
  }

  const auth = `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;

  // Hit /wp-json/wp/v2/settings — requires authentication, so this proves both
  // that WordPress is reachable AND that the credentials are valid.
  let res: Response;
  try {
    res = await fetch(`${appUrl}/wp-json/wp/v2/settings`, {
      headers: { Authorization: auth },
    });
  } catch (err) {
    return { ok: false, message: `Could not reach ${appUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: `Credentials rejected by WordPress (${res.status}). Check TEMPLATE_WP_USERNAME and TEMPLATE_WP_APP_PASSWORD.`,
    };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `WordPress settings endpoint returned ${res.status}: ${text.slice(0, 200)}` };
  }

  const settings = await res.json();

  return {
    ok: true,
    siteTitle: settings.title ?? '(no title)',
    wpVersion: undefined, // not exposed by the settings endpoint
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    return await runChecks();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      checks: [{ name: 'Error', ok: false, message }],
    });
  }
}

async function runChecks() {
  const results: CheckResult[] = [];

  // 1. Cloudways auth
  const authResult = await checkCloudwaysAuth();
  results.push({
    name: 'Cloudways Auth',
    ok: authResult.ok,
    message: authResult.ok
      ? `Authenticated successfully (${process.env.CLOUDWAYS_EMAIL})`
      : authResult.message,
  });
  if (!authResult.ok) return NextResponse.json({ checks: results });

  // 2. Server
  const serverResult = await checkServer(authResult.token);
  results.push({
    name: 'Server',
    ok: serverResult.ok,
    message: serverResult.ok
      ? `Found server "${serverResult.serverLabel}" with ${serverResult.apps.length} app(s)`
      : serverResult.message,
  });
  if (!serverResult.ok) return NextResponse.json({ checks: results });

  // 3. Template app
  const appResult = await checkTemplateApp(serverResult.apps);
  results.push({
    name: 'Template App',
    ok: appResult.ok,
    message: appResult.ok
      ? `Found app "${appResult.appLabel}" at ${appResult.appUrl}`
      : appResult.message,
  });
  if (!appResult.ok) return NextResponse.json({ checks: results });

  // 4. WordPress
  const wpResult = await checkWordPress(appResult.appUrl);
  results.push({
    name: 'WordPress',
    ok: wpResult.ok,
    message: wpResult.ok
      ? `Connected — site title: "${wpResult.siteTitle}"`
      : wpResult.message,
  });

  // 5. SSH + WP-CLI (optional — skipped if SSH vars not set)
  if (isSshConfigured()) {
    try {
      const sshResult = await testSshConnection();
      const pending = sshResult.pluginsNeedingUpdate;
      results.push({
        name: 'SSH / WP-CLI',
        ok: true,
        message: `${sshResult.wpCliVersion} · ${pending === 0 ? 'All plugins up to date' : `${pending} plugin${pending === 1 ? '' : 's'} need updating`}`,
      });
    } catch (err) {
      results.push({
        name: 'SSH / WP-CLI',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    results.push({
      name: 'SSH / WP-CLI',
      ok: true,
      message: 'Not configured (SSH_HOST, SSH_USER, SSH_KEY_PATH not set) — plugin updates will be skipped',
    });
  }

  return NextResponse.json({ checks: results });
}
