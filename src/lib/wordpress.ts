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

async function getKitData(creds: WpCredentials): Promise<ElementorKitData> {
  const res = await wpFetch(creds, '/elementor/v1/kit-data');
  if (!res.ok) throw new Error(`Get Elementor kit failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Update Elementor global colours and typography via the Elementor REST API.
 *
 * Elementor stores these in the "Site Kit" post under `system_colors` and
 * `system_typography`. We read the current kit, patch only those keys, then
 * write it back.
 */
export async function updateElementorGlobals(
  creds: WpCredentials,
  colors: ElementorColor[],
  typography: ElementorTypography[],
): Promise<void> {
  // Read current kit so we don't clobber unrelated settings
  const kitData = await getKitData(creds);

  const updatedSettings = {
    ...kitData.settings,
    system_colors: colors,
    system_typography: typography,
  };

  // Elementor's kit-data endpoint accepts POST to update
  const res = await wpFetch(creds, '/elementor/v1/kit-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: updatedSettings }),
  });

  if (!res.ok) {
    const text = await res.text();
    // Provide a useful hint if the endpoint isn't found — common if Elementor
    // is not activated on the fresh clone yet.
    if (res.status === 404) {
      throw new Error(
        `Elementor kit endpoint not found (404). Make sure Elementor is active on the cloned site before configuring globals. Raw: ${text}`,
      );
    }
    throw new Error(`Update Elementor kit failed (${res.status}): ${text}`);
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
