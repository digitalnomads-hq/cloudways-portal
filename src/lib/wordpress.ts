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
 * Uses POST /elementor/v1/globals/colors/{id} and
 *      POST /elementor/v1/globals/typography/{id}
 * which are confirmed present in wp-json for this Elementor setup.
 */
export async function updateElementorGlobals(
  creds: WpCredentials,
  colors: ElementorColor[],
  typography: ElementorTypography[],
): Promise<void> {
  for (const color of colors) {
    const res = await wpFetch(creds, `/elementor/v1/globals/colors/${encodeURIComponent(color._id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: color._id, title: color.title, value: { color: color.color } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update Elementor color "${color._id}" failed (${res.status}): ${text}`);
    }
  }

  for (const typo of typography) {
    const res = await wpFetch(creds, `/elementor/v1/globals/typography/${encodeURIComponent(typo._id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: typo._id,
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
      throw new Error(`Update Elementor typography "${typo._id}" failed (${res.status}): ${text}`);
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
    await updateElementorGlobals(creds, params.colors, params.typography);
    onStep('  Elementor globals updated.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Elementor: ${msg}`);
  }
}
