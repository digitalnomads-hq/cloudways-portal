import { NextResponse } from 'next/server';

let cache: { fonts: string[]; expiresAt: number } | null = null;

export async function GET() {
  if (cache && Date.now() < cache.expiresAt) {
    return NextResponse.json({ fonts: cache.fonts });
  }

  try {
    const res = await fetch('https://fonts.google.com/metadata/fonts', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 86400 }, // Next.js cache: 24h
    });

    if (!res.ok) throw new Error(`Google Fonts metadata returned ${res.status}`);

    const text = await res.text();
    // The response starts with ")]}'" to prevent JSON hijacking — strip it
    const json = JSON.parse(text.replace(/^\)\]\}'\n/, ''));
    const fonts: string[] = (json.familyMetadataList ?? [])
      .map((f: { family: string }) => f.family)
      .sort();

    cache = { fonts, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    return NextResponse.json({ fonts });
  } catch (err) {
    // Fallback to a basic list if Google's endpoint is unreachable
    return NextResponse.json({
      fonts: ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Raleway', 'Nunito', 'Playfair Display', 'Merriweather'],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
