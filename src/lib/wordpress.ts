export interface WpCredentials {
  baseUrl: string; // e.g. https://abc123.cloudwaysapps.com
  username: string;
  appPassword: string;
}

export interface ElementorColor {
  _id: string;
  title: string;
  color: string;
}

export interface ElementorTypography {
  _id: string;
  title: string;
  typography_typography: 'custom' | 'default';
  typography_font_family: string;
  typography_font_weight?: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function wpFetch(
  creds: WpCredentials,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${creds.baseUrl.replace(/\/$/, '')}/wp-json${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: basicAuth(creds.username, creds.appPassword),
      ...(options.headers as Record<string, string>),
    },
  });
}

// ------------------------------------------------------------------
// Site settings
// ------------------------------------------------------------------

/** Update site title and tagline. */
export async function updateSiteSettings(
  creds: WpCredentials,
  settings: { title: string; description: string },
): Promise<void> {
  const res = await wpFetch(creds, '/wp/v2/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Site settings update failed (${res.status}): ${await res.text()}`);
}

// ------------------------------------------------------------------
// Logo
// ------------------------------------------------------------------

/** Upload a logo file and return its media ID. */
export async function uploadLogo(
  creds: WpCredentials,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<number> {
  const res = await wpFetch(creds, '/wp/v2/media', {
    method: 'POST',
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': mimeType,
    },
    body: buffer as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`Logo upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.id as number;
}

/** Set the uploaded media item as the site logo. */
export async function setSiteLogo(creds: WpCredentials, mediaId: number): Promise<void> {
  const res = await wpFetch(creds, '/wp/v2/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_logo: mediaId }),
  });
  if (!res.ok) throw new Error(`Set site logo failed (${res.status}): ${await res.text()}`);
}

// ------------------------------------------------------------------
// Elementor kit (global colours + typography)
// ------------------------------------------------------------------

/**
 * Update Elementor global colours and typography via the individual globals endpoints.
 *
 * Strategy: GET the existing globals first to discover the real IDs of the default
 * system entries (Elementor stores them with hashed IDs, not "primary"/"secondary").
 * Match by title, update in-place. If no match is found, fall back to creating a
 * new entry using the caller-supplied ID.
 */
export async function updateElementorGlobals(
  creds: WpCredentials,
  colors: ElementorColor[],
  typography: ElementorTypography[],
  onStep?: (msg: string) => void,
): Promise<void> {
  // ------------------------------------------------------------------
  // Colours
  // ------------------------------------------------------------------
  let existingColors: Array<{ id: string; title: string }> = [];
  try {
    const listRes = await wpFetch(creds, '/elementor/v1/globals/colors');
    if (listRes.ok) {
      const data = await listRes.json();
      onStep?.(`  DEBUG colors response: ${JSON.stringify(data).slice(0, 300)}`);
      // Response may be an object keyed by ID or an array
      existingColors = Array.isArray(data)
        ? data
        : Object.values(data as Record<string, { id: string; title: string }>);
    }
  } catch { /* non-fatal — fall back to caller IDs */ }

  for (const color of colors) {
    // Try to find an existing system color whose title matches (case-insensitive)
    const existing = existingColors.find(
      (c) => c.title.toLowerCase() === color.title.toLowerCase(),
    );
    const targetId = existing?.id ?? color._id;
    onStep?.(`  Setting color "${color.title}" → id="${targetId}" value="${color.color}"`);

    const res = await wpFetch(creds, `/elementor/v1/globals/colors/${encodeURIComponent(targetId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: targetId, title: color.title, value: { color: color.color } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update Elementor color "${color.title}" failed (${res.status}): ${text}`);
    }
  }

  // ------------------------------------------------------------------
  // Typography
  // ------------------------------------------------------------------
  let existingTypo: Array<{ id: string; title: string }> = [];
  try {
    const listRes = await wpFetch(creds, '/elementor/v1/globals/typography');
    if (listRes.ok) {
      const data = await listRes.json();
      existingTypo = Array.isArray(data)
        ? data
        : Object.values(data as Record<string, { id: string; title: string }>);
    }
  } catch { /* non-fatal */ }

  for (const typo of typography) {
    const existing = existingTypo.find(
      (t) => t.title.toLowerCase() === typo.title.toLowerCase(),
    );
    const targetId = existing?.id ?? typo._id;

    const res = await wpFetch(creds, `/elementor/v1/globals/typography/${encodeURIComponent(targetId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: targetId,
        title: typo.title,
        value: {
          typography: typo.typography_typography,
          font_family: typo.typography_font_family,
          font_weight: typo.typography_font_weight,
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update Elementor typography "${typo.title}" failed (${res.status}): ${text}`);
    }
  }
}

/**
 * Check for plugins with available updates via the WP REST API.
 * Returns the names of plugins that need updating.
 * Note: the WP REST API does not support triggering version updates —
 * updates must be applied manually in WP Admin or via WP-CLI.
 */
export async function checkPluginUpdates(
  creds: WpCredentials,
  onStep: (msg: string) => void,
): Promise<void> {
  onStep('Checking template site for plugin updates…');

  const res = await wpFetch(creds, '/wp/v2/plugins?context=edit&per_page=100');
  if (!res.ok) {
    onStep(`  Could not retrieve plugin list (${res.status}) — skipping check`);
    return;
  }

  const plugins: Array<{ name: string; plugin: string; version: string; update?: unknown }> = await res.json();
  const needsUpdate = plugins.filter((p) => p.update && p.update !== null && p.update !== false);

  if (needsUpdate.length === 0) {
    onStep('  All plugins are up to date.');
  } else {
    const names = needsUpdate.map((p) => p.name).join(', ');
    onStep(`  ⚠ ${needsUpdate.length} plugin${needsUpdate.length === 1 ? '' : 's'} need updating: ${names}`);
    onStep('  Update these in WP Admin → Plugins on the template site before cloning for best results.');
  }
}

/** Run all WordPress configuration steps in sequence. */
export async function configureWordPress(
  creds: WpCredentials,
  params: {
    title: string;
    tagline: string;
    logoBuffer: Buffer | null;
    logoFilename: string;
    logoMimeType: string;
    colors: ElementorColor[];
    typography: ElementorTypography[];
  },
  onStep: (msg: string) => void,
): Promise<void> {
  onStep('Updating site title and tagline…');
  await updateSiteSettings(creds, { title: params.title, description: params.tagline });

  if (params.logoBuffer) {
    onStep('Uploading logo…');
    const mediaId = await uploadLogo(
      creds,
      params.logoBuffer,
      params.logoFilename,
      params.logoMimeType,
    );
    onStep('Setting site logo…');
    await setSiteLogo(creds, mediaId);
  }

  onStep('Updating Elementor global colours and fonts…');
  try {
    await updateElementorGlobals(creds, params.colors, params.typography, onStep);
    onStep('  Elementor globals updated.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Elementor: ${msg}`);
  }
}
