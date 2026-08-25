import dns from 'node:dns/promises';
import net from 'node:net';

// Guard for URLs that come from user input and get fetched server-side.
//
// Without this, "extract colours from this URL" is a request forwarder running
// inside the deployment's network: it can reach cloud metadata endpoints,
// localhost services, and anything else on the private network that is not
// exposed publicly.

/** Ranges that must never be reachable from a user-supplied URL. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → refuse

  const [a, b] = p;
  return (
    a === 0 ||                          // 0.0.0.0/8 "this network"
    a === 10 ||                         // private
    a === 127 ||                        // loopback
    (a === 169 && b === 254) ||         // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) ||         // private
    (a === 100 && b >= 64 && b <= 127) ||    // carrier-grade NAT
    (a === 192 && b === 0) ||           // IETF protocol assignments
    a === 224 ||                        // multicast
    a >= 240                            // reserved / broadcast
  );
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip zone id
  if (addr === '::' || addr === '::1') return true;         // unspecified / loopback
  if (addr.startsWith('fe80')) return true;                  // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
  if (addr.startsWith('ff')) return true;                    // multicast

  // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all → refuse
}

/**
 * Reject a URL unless it is http(s) and every address its host resolves to is
 * public.
 *
 * Checking all resolved addresses matters: a hostname can return both a public
 * and a private address, and validating only the first would let the private
 * one through on a later connection.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap bracketed IPv6

  // A literal IP skips DNS entirely.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('That address is not publicly routable.');
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }

  if (addresses.length === 0) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('That hostname resolves to a private address.');
  }
}

/**
 * fetch that validates every hop rather than trusting the first.
 *
 * A public URL can redirect to a private one, so following redirects
 * automatically would defeat the check above.
 */
export async function safeFetch(
  startUrl: URL,
  init: RequestInit,
  maxRedirects = 3,
): Promise<Response> {
  let url = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(url);

    const res = await fetch(url.toString(), { ...init, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      url = new URL(location, url); // resolve relative redirects
      continue;
    }

    return res;
  }

  throw new Error('Too many redirects.');
}
