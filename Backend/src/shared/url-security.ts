// Blocks SSRF at the point an outbound URL is registered/used: only plain http(s)
// to a resolvable public host is accepted, so this can't be pointed at internal
// services, the cloud metadata endpoint, or other addresses on the server's own
// network. This checks the literal hostname in the URL, not a DNS-rebinding-proof
// fetch-time re-check — good enough as a create/use-time gate.
function isBlockedIpv4(a: number, b: number): boolean {
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

export function isPublicHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Never accept credentials embedded in the URL (http://user:pass@host/...) — not an
  // SSRF vector itself, but it has no legitimate use here and some HTTP clients treat
  // it unpredictably.
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;

  // Bracketed IPv6 literal: reject every non-global form outright (loopback ::1,
  // unspecified ::, link-local fe80::/10, unique-local fc00::/7, and IPv4-mapped
  // ::ffff:a.b.c.d — which must be unwrapped and re-checked against the IPv4 rules
  // above, since ::ffff:169.254.169.254 is the cloud-metadata address in disguise).
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return false;
    if (/^fe80:/i.test(v6) || /^f[cd][0-9a-f]{2}:/i.test(v6)) return false;
    const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped) {
      const [a, b] = mapped[1].split('.').map(Number);
      if (isBlockedIpv4(a, b)) return false;
    }
    return true;
  }
  if (host === '::1') return false;

  // Plain dotted-decimal IPv4 (four \d{1,3} parts) — check against private ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (isBlockedIpv4(a, b)) return false;
    return true;
  }

  // Alternate numeric-IP encodings that resolve exactly like an IPv4 literal but
  // don't match the dotted-decimal shape above: a single decimal (2130706433 ==
  // 127.0.0.1), 0x-prefixed hex, or dotted parts that are hex/octal (0x7f.0.0.1,
  // 0177.0.0.1). Real hostnames are never *purely* digits/hex-with-0x — reject these
  // outright rather than trying to decode and re-check them.
  if (/^\d+$/.test(host)) return false; // bare decimal, e.g. 2130706433
  if (/^0x[0-9a-f]+$/i.test(host)) return false; // bare hex, e.g. 0x7f000001
  if (/^\d+(\.\d+){1,3}$/.test(host)) return false; // dotted-decimal with a non-4-octet shape, e.g. "127.1"
  if (/^0x[0-9a-f]+(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) return false; // dotted hex, e.g. 0x7f.0.0.1

  return true;
}
