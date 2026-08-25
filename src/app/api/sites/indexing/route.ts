import { NextRequest, NextResponse } from 'next/server';
import { getSite, setIndexing } from '@/lib/registry';
import { setSearchIndexing } from '@/lib/wp-setup';

// Toggle "Discourage search engines" on a site created by this portal.
//
// New sites are provisioned with indexing off so a half-built site never gets
// crawled; this is what turns it back on at launch.
//
// The target is identified by appId and the URL is read from the registry —
// never taken from the request. That keeps the WordPress credentials from
// being sent anywhere the portal did not itself create.

export async function POST(req: NextRequest) {
  let appId: string;
  let enabled: boolean;

  try {
    const body = await req.json();
    appId = String(body.appId ?? '');
    enabled = Boolean(body.enabled);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  const site = await getSite(appId);
  if (!site) {
    return NextResponse.json(
      { error: 'Unknown site — it is not in the registry.' },
      { status: 404 },
    );
  }

  const creds = {
    baseUrl: site.siteUrl,
    username: process.env.TEMPLATE_WP_USERNAME!,
    appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
  };

  try {
    await setSearchIndexing(creds, enabled);
    await setIndexing(appId, enabled);
    return NextResponse.json({ ok: true, indexing: enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
