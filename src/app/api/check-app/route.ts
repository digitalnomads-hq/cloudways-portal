import { NextRequest, NextResponse } from 'next/server';
import { findAppByLabel } from '@/lib/cloudways';

export async function GET(req: NextRequest) {
  const label = new URL(req.url).searchParams.get('label');
  if (!label) return NextResponse.json({ exists: false });

  try {
    const app = await findAppByLabel(label);
    if (app) {
      const url = app.app_fqdn ? `https://${app.app_fqdn}` : `http://${app.cname}`;
      return NextResponse.json({ exists: true, url });
    }
    return NextResponse.json({ exists: false });
  } catch {
    // If the check fails, don't block the user — just return no duplicate
    return NextResponse.json({ exists: false });
  }
}
