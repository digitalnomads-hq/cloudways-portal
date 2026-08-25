import { NextRequest, NextResponse } from 'next/server';
import { listSites, forgetSite } from '@/lib/registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { sites, dbAvailable } = await listSites();
  return NextResponse.json({ sites, dbAvailable });
}

/** Remove a site from the registry. Does not touch the Cloudways app. */
export async function DELETE(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get('appId');
  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  try {
    await forgetSite(appId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
