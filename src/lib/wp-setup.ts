import type { WpCredentials } from './wordpress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function wpFetch(creds: WpCredentials, path: string, options: RequestInit = {}) {
  const url = `${creds.baseUrl.replace(/\/$/, '')}/wp-json${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: basicAuth(creds.username, creds.appPassword),
      ...(options.headers as Record<string, string>),
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Delete default content
// ---------------------------------------------------------------------------

/**
 * Remove the "Hello World" post, "Sample Page", and default comment that
 * WordPress ships with on every fresh install.
 */
export async function deleteDefaultContent(
  creds: WpCredentials,
  onStep: (msg: string) => void,
): Promise<void> {
  onStep('Removing default WordPress content…');

  const deletes: Array<{ type: string; path: string }> = [
    { type: 'Hello World post', path: '/wp/v2/posts/1?force=true' },
    { type: 'Sample Page', path: '/wp/v2/pages/2?force=true' },
    { type: 'default comment', path: '/wp/v2/comments/1?force=true' },
  ];

  for (const { type, path } of deletes) {
    const res = await wpFetch(creds, path, { method: 'DELETE' });
    if (res.ok) {
      onStep(`  Deleted ${type}`);
    } else if (res.status === 404) {
      onStep(`  ${type} not found — already removed`);
    } else {
      onStep(`  Could not delete ${type} (${res.status}) — skipping`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Site settings (timezone, comments, front page)
// ---------------------------------------------------------------------------

export async function configureSiteSettings(
  creds: WpCredentials,
  homePageId: number,
  onStep: (msg: string) => void,
): Promise<void> {
  onStep('Configuring site settings…');

  const settings: Record<string, unknown> = {
    timezone: 'Australia/Sydney',
    default_comment_status: 'closed',  // disable comments globally
    default_ping_status: 'closed',     // disable pingbacks
    show_on_front: 'page',
    page_on_front: homePageId,
  };

  const res = await wpFetch(creds, '/wp/v2/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    onStep(`  Settings update returned ${res.status} — some settings may not have applied`);
  } else {
    onStep('  Timezone set to Australia/Sydney');
    onStep('  Comments and pingbacks disabled');
    onStep('  Front page set to Home');
  }
}

// ---------------------------------------------------------------------------
// 3. Standard pages
// ---------------------------------------------------------------------------

export interface StandardPages {
  home: number;
  about: number;
  services: number;
  contact: number;
  privacy: number;
}

const PAGE_DEFINITIONS = [
  {
    key: 'home' as const,
    title: 'Home',
    content: '',
  },
  {
    key: 'about' as const,
    title: 'About',
    content: '',
  },
  {
    key: 'services' as const,
    title: 'Services',
    content: '',
  },
  {
    key: 'contact' as const,
    title: 'Contact',
    content: '',
  },
  {
    key: 'privacy' as const,
    title: 'Privacy Policy',
    content: '<p>This privacy policy sets out how we collect, use and protect any information you provide when using this website.</p>',
  },
];

export async function createStandardPages(
  creds: WpCredentials,
  onStep: (msg: string) => void,
): Promise<StandardPages> {
  onStep('Creating standard pages…');

  const ids: Partial<StandardPages> = {};

  for (const page of PAGE_DEFINITIONS) {
    const res = await wpFetch(creds, '/wp/v2/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: page.title,
        status: 'publish',
        content: page.content,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to create "${page.title}" page (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    ids[page.key] = data.id as number;
    onStep(`  Created page: ${page.title} (ID ${data.id})`);
  }

  return ids as StandardPages;
}
