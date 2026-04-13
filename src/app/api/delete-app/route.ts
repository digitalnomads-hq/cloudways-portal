import { NextRequest, NextResponse } from 'next/server';

const API_BASE = 'https://api.cloudways.com/api/v1';

async function getToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: process.env.CLOUDWAYS_EMAIL!,
      api_key: process.env.CLOUDWAYS_API_KEY!,
    }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status})`);
  const data = await res.json();
  return data.access_token;
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const appId = searchParams.get('appId');
  const serverId = process.env.CLOUDWAYS_SERVER_ID;

  if (!appId || !serverId) {
    return NextResponse.json({ error: 'Missing appId or server config' }, { status: 400 });
  }

  try {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/app`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ server_id: serverId, app_id: appId }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Delete failed (${res.status}): ${text}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
