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

interface ElementorKitData {
  settings: Record<string, unknown>;
  [key: string]: unknown;
}

/** Ensure Elementor is active — activate it via the WP plugins REST API if needed. */
async function ensureElementorActive(creds: WpCredentials): Promise<void> {
  // Check plugin status
  const listRes = await wpFetch(creds, '/wp/v2/plugins?search=elementor');
  if (!listRes.ok) return; // Can't check — proceed anyway

  const plugins: Array<{ plugin: string; status: string; name: string }> = await listRes.json();
  const elementor = plugins.find((p) => p.plugin.startsWith('elementor/'));
  if (!elementor) return; // Not found — nothing to activate

  if (elementor.status === 'active') return; // Already active

  // Activate it
  await wpFetch(creds, `/wp/v2/plugins/${encodeURIComponent(elementor.plugin)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  });

  // Give WordPress a moment to finish activating
  await new Promise((r) => setTimeout(r, 3000));
}

async function getKitData(creds: WpCredentials): Promise<ElementorKitData> {
  const res = await wpFetch(creds, '/elementor/v1/kit-data');
  if (!res.ok) throw new Error(`Get Elementor kit failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Update Elementor global colours and typography via the Elementor REST API.
 *
 * If the kit endpoint returns 404, Elementor is likely inactive on the clone —
 * we activate it via the WP plugins API then retry once.
 */
export async function updateElementorGlobals(
  creds: WpCredentials,
  colors: ElementorColor[],
  typography: ElementorTypography[],
): Promise<void> {
  const applyKit = async (): Promise<void> => {
    const kitData = await getKitData(creds);

    const updatedSettings = {
      ...kitData.settings,
      system_colors: colors,
      system_typography: typography,
    };

    const res = await wpFetch(creds, '/elementor/v1/kit-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: updatedSettings }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update Elementor kit failed (${res.status}): ${text}`);
    }
  };

  try {
    await applyKit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) {
      // Elementor likely inactive — activate and retry once
      await ensureElementorActive(creds);
      await applyKit();
    } else {
      throw err;
    }
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
  await updateElementorGlobals(creds, params.colors, params.typography);
}
