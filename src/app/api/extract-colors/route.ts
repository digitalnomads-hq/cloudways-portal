import { NextRequest, NextResponse } from 'next/server';

// Extract a brand colour palette by scanning a page + its stylesheets for
// hex/rgb colour values. Returns the most frequent distinct, non-grayscale
// colours — enough to fill Primary / Secondary / Accent / Text.

export const maxDuration = 30;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function normaliseHex(hex: string): string {
  const h = hex.replace('#', '').toLowerCase();
  if (h.length === 3) {
    return '#' + h.split('').map((c) => c + c).join('');
  }
  if (h.length === 8) return '#' + h.slice(0, 6); // drop alpha
  return '#' + h;
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0'))
      .join('')
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function isNearGrayscale(hex: string, tolerance = 12): boolean {
  const [r, g, b] = hexToRgb(hex);
  return (
    Math.abs(r - g) <= tolerance &&
    Math.abs(g - b) <= tolerance &&
    Math.abs(r - b) <= tolerance
  );
}

function isNearExtreme(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  const avg = (r + g + b) / 3;
  return avg < 12 || avg > 245;
}

function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,text/css,*/*;q=0.8' },
    signal,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  return await res.text();
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get('url');
  if (!rawUrl) {
    return NextResponse.json({ error: 'url query param required' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http(s) URLs allowed' }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const html = await fetchText(target.toString(), controller.signal);

    // Find linked stylesheets (limit to first 5 to keep scan quick)
    const linkRegex = /<link\b[^>]*>/gi;
    const hrefRegex = /href=["']([^"']+)["']/i;
    const cssUrls: string[] = [];
    for (const m of html.matchAll(linkRegex)) {
      const tag = m[0];
      if (!/rel=["'][^"']*stylesheet/i.test(tag)) continue;
      const href = tag.match(hrefRegex)?.[1];
      if (!href) continue;
      try {
        cssUrls.push(new URL(href, target).toString());
      } catch {
        // ignore bad URLs
      }
      if (cssUrls.length >= 5) break;
    }

    let combined = html;
    for (const cssUrl of cssUrls) {
      try {
        const css = await fetchText(cssUrl, controller.signal);
        combined += '\n' + css;
      } catch {
        // Skip failed stylesheet fetches
      }
    }

    // Count colour occurrences
    const counts = new Map<string, number>();
    const bump = (hex: string) => {
      if (isNearExtreme(hex) || isNearGrayscale(hex)) return;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    };

    // Hex (#rgb, #rrggbb, #rrggbbaa)
    const hexRegex = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
    for (const m of combined.matchAll(hexRegex)) {
      bump(normaliseHex(m[1]));
    }

    // rgb() / rgba()
    const rgbRegex = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
    for (const m of combined.matchAll(rgbRegex)) {
      bump(rgbToHex(+m[1], +m[2], +m[3]));
    }

    // Sort by frequency, then greedily pick colours that aren't too close
    // to ones already chosen.
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const palette: string[] = [];
    for (const [hex] of sorted) {
      if (palette.some((p) => colorDistance(p, hex) < 40)) continue;
      palette.push(hex);
      if (palette.length >= 6) break;
    }

    return NextResponse.json({
      url: target.toString(),
      palette,
      totalDistinct: counts.size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
