import { NextResponse } from 'next/server';

export async function GET() {
  const baseUrl = process.env.TEMPLATE_WP_URL;
  const username = process.env.TEMPLATE_WP_USERNAME;
  const appPassword = process.env.TEMPLATE_WP_APP_PASSWORD;

  if (!baseUrl || !username || !appPassword) {
    return NextResponse.json({ plugins: [] });
  }

  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/plugins?context=edit&per_page=100`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    return NextResponse.json({ plugins: [] });
  }

  const data: Array<{ plugin: string; name: string; status: string; description?: { raw?: string } }> = await res.json();
  const plugins = data.map((p) => ({
    plugin: p.plugin,
    name: p.name,
    status: p.status,
  }));

  return NextResponse.json({ plugins });
}
