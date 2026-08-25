import type { WpCredentials } from './wordpress';
import { wpFetch } from './wordpress';

export interface NavPage { title: string; id: number; }

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
    const res = await wpFetch(creds, path, { method: 'DELETE' }, onStep);
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
    blog_public: false,                // discourage search engine indexing
  };

  const res = await wpFetch(creds, '/wp/v2/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }, onStep);

  if (!res.ok) {
    onStep(`  Settings update returned ${res.status} — some settings may not have applied`);
  } else {
    onStep('  Timezone set to Australia/Sydney');
    onStep('  Comments and pingbacks disabled');
    onStep('  Front page set to Home');
    onStep('  Search engine indexing discouraged (re-enable before launch)');
  }
}

// ---------------------------------------------------------------------------
// 4. Navigation menu
// ---------------------------------------------------------------------------

export async function createNavMenu(
  creds: WpCredentials,
  pages: NavPage[],
  onStep: (msg: string) => void,
): Promise<void> {
  onStep('Creating navigation menu…');

  // Reuse an existing Primary Menu if there is one, so a resumed build does not
  // leave the site with a second menu and duplicated items.
  let menuId: number | null = null;

  const existingRes = await wpFetch(creds, '/wp/v2/menus?search=Primary%20Menu&per_page=20');
  if (existingRes.ok) {
    const menus: Array<{ id: number; name: string }> = await existingRes.json();
    menuId = menus.find((m) => m.name?.trim().toLowerCase() === 'primary menu')?.id ?? null;
    if (menuId) onStep(`  Reusing existing Primary Menu (ID ${menuId})`);
  }

  if (!menuId) {
    const menuRes = await wpFetch(creds, '/wp/v2/menus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Primary Menu' }),
    }, onStep);

    if (!menuRes.ok) {
      onStep(`  Could not create menu (${menuRes.status}) — skipping`);
      return;
    }
    menuId = (await menuRes.json()).id as number;
  }

  // Existing items, so we only add what is missing.
  const existingTitles = new Set<string>();
  const itemsRes = await wpFetch(creds, `/wp/v2/menu-items?menus=${menuId}&per_page=100`);
  if (itemsRes.ok) {
    const items: Array<{ title: { rendered: string } }> = await itemsRes.json();
    for (const it of items) {
      if (it.title?.rendered) existingTitles.add(it.title.rendered.trim().toLowerCase());
    }
  }

  for (const page of pages) {
    if (existingTitles.has(page.title.toLowerCase())) {
      onStep(`  "${page.title}" already in menu`);
      continue;
    }
    const itemRes = await wpFetch(creds, '/wp/v2/menu-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: page.title,
        type: 'post_type',
        object: 'page',
        object_id: page.id,
        menus: menuId,
        status: 'publish',
      }),
    }, onStep);
    onStep(itemRes.ok ? `  Added "${page.title}" to menu` : `  Could not add "${page.title}" (${itemRes.status})`);
  }

  // Attempt to assign to the primary theme location
  const assignRes = await wpFetch(creds, `/wp/v2/menus/${menuId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: ['primary'] }),
  }, onStep);
  onStep(assignRes.ok
    ? '  Assigned to primary menu location'
    : '  Could not auto-assign menu location — assign manually in Appearance → Menus',
  );
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

/**
 * Look up an existing page by exact title.
 *
 * Makes page creation idempotent, which a resumed build depends on — otherwise
 * re-running this phase would leave the site with two of every page.
 */
async function findPageByTitle(creds: WpCredentials, title: string): Promise<number | null> {
  const res = await wpFetch(
    creds,
    `/wp/v2/pages?search=${encodeURIComponent(title)}&status=publish,draft&per_page=20`,
  );
  if (!res.ok) return null;

  const pages: Array<{ id: number; title: { rendered: string } }> = await res.json();
  // `search` is fuzzy, so confirm the title actually matches before reusing it.
  const match = pages.find(
    (p) => p.title?.rendered?.trim().toLowerCase() === title.toLowerCase(),
  );
  return match?.id ?? null;
}

export async function createStandardPages(
  creds: WpCredentials,
  onStep: (msg: string) => void,
): Promise<StandardPages> {
  onStep('Creating standard pages…');

  const ids: Partial<StandardPages> = {};

  for (const page of PAGE_DEFINITIONS) {
    const existing = await findPageByTitle(creds, page.title);
    if (existing) {
      ids[page.key] = existing;
      onStep(`  Page already exists: ${page.title} (ID ${existing})`);
      continue;
    }

    const res = await wpFetch(creds, '/wp/v2/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: page.title,
        status: 'publish',
        content: page.content,
      }),
    }, onStep);

    if (!res.ok) {
      throw new Error(`Failed to create "${page.title}" page (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    ids[page.key] = data.id as number;
    onStep(`  Created page: ${page.title} (ID ${data.id})`);
  }

  return ids as StandardPages;
}

/**
 * Turn search engine indexing on or off (the "Discourage search engines"
 * setting). New sites are created with indexing off; this is what flips it
 * back on at launch.
 */
export async function setSearchIndexing(
  creds: WpCredentials,
  enabled: boolean,
): Promise<void> {
  const res = await wpFetch(creds, '/wp/v2/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blog_public: enabled }),
  });

  if (!res.ok) {
    throw new Error(`Could not update indexing setting (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}
