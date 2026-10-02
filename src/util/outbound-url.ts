/**
 * A-12: every outbound face (agent-card fetch, A2A dispatch, MCP connector
 * handshake and tool call) resolves a URL that an operator or an onboarding
 * caller supplied. Without a guard the kernel — which holds the internal bearer
 * — will fetch whatever host that URL names, including the cloud metadata
 * endpoint and other addresses that are reachable from inside the deployment
 * but are not meant to be reachable from a request.
 *
 * The guard refuses any target that is not globally reachable, following the
 * RFC 6890 special-purpose registry. One deliberate deviation: 127.0.0.0/8 and
 * ::1 stay open. Zeus is local-first, so a loopback vassal / MCP server is the
 * normal case, not the exception — and a loopback target cannot exfiltrate a
 * request to a third party. An operator who runs peers on a private network
 * re-opens those hosts explicitly through ZEUS_OUTBOUND_ALLOW_HOSTS.
 *
 * A hostname that is not an IP literal passes this synchronous check, but it is
 * not trusted on the wire: outbound-dns.ts resolves it through a guarded
 * connect lookup that runs every resolved address through the same registry and
 * pins the connection to an address that passed, so a DNS record pointing at a
 * private address — or changing between resolve and connect — cannot bypass
 * this guard.
 */

export class OutboundUrlError extends Error {}

/** Comma-separated hostnames; `.suffix` entries match a whole suffix. */
export function parseAllowHosts(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
    : [];
}

export function normaliseHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isAllowlisted(host: string, allowHosts: readonly string[]): boolean {
  return allowHosts.some(raw => {
    const entry = normaliseHost(raw);
    if (entry.length === 0) return false;
    if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
    return host === entry;
  });
}

/** Four dotted decimal octets, or undefined when the host is not a literal IPv4.
 *  WHATWG URL already canonicalises every accepted IPv4 spelling (hex, octal,
 *  short form), so reading `.hostname` is enough. */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  // Four pushes for exactly four parts: the tuple shape is structural.
  return octets as [number, number, number, number];
}

function wordsToBytes(words: number[]): number[] {
  const bytes: number[] = [];
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff);
  return bytes;
}

/** Parse an IPv6 literal into 16 bytes, or undefined when it is malformed.
 *  Handles `::` compression, a trailing `%zone`, and embedded IPv4. */
function parseIpv6(host: string): number[] | undefined {
  const zone = host.indexOf('%');
  const body = zone === -1 ? host : host.slice(0, zone);
  const split = body.indexOf('::');
  if (split !== -1 && body.indexOf('::', split + 2) !== -1) return undefined;
  const head = split === -1 ? body : body.slice(0, split);
  const tail = split === -1 ? '' : body.slice(split + 2);

  const wordsIn = (parts: string[]): number[] | undefined => {
    const words: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      // The loop bound guarantees existence; `?? ''` keeps the empty-string
      // rejection path identical whether the slot is absent or genuinely empty.
      const part = parts[i] ?? '';
      if (part === '') return undefined;
      if (part.includes('.')) {
        if (i !== parts.length - 1) return undefined;
        const v4 = parseIpv4(part);
        if (!v4) return undefined;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      words.push(parseInt(part, 16));
    }
    return words;
  };

  const headWords = wordsIn(head === '' ? [] : head.split(':'));
  const tailWords = wordsIn(tail === '' ? [] : tail.split(':'));
  if (!headWords || !tailWords) return undefined;

  if (split === -1) {
    return headWords.length === 8 ? wordsToBytes(headWords) : undefined;
  }
  const fill = 8 - headWords.length - tailWords.length;
  if (fill < 1) return undefined;
  return wordsToBytes([...headWords, ...new Array(fill).fill(0), ...tailWords]);
}

function ipv4BlockedReason(octets: [number, number, number, number]): string | undefined {
  const [a, b, c] = octets;
  // Deviation from RFC 6890: loopback stays reachable (local-first).
  if (a === 127) return undefined;
  if (a === 0) return 'this-network 0.0.0.0/8';
  if (a === 10) return 'RFC1918 10.0.0.0/8';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT 100.64.0.0/10';
  if (a === 169 && b === 254) return 'link-local 169.254.0.0/16';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 172.16.0.0/12';
  if (a === 192 && b === 0 && c === 0) return 'IETF-assignment 192.0.0.0/24';
  if (a === 192 && b === 0 && c === 2) return 'documentation 192.0.2.0/24';
  if (a === 192 && b === 168) return 'RFC1918 192.168.0.0/16';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark 198.18.0.0/15';
  if (a === 198 && b === 51 && c === 100) return 'documentation 198.51.100.0/24';
  if (a === 203 && b === 0 && c === 113) return 'documentation 203.0.113.0/24';
  if (a >= 224 && a <= 239) return 'multicast 224.0.0.0/4';
  if (a >= 240) return 'reserved 240.0.0.0/4';
  return undefined;
}

function ipv6BlockedReason(bytes: number[]): string | undefined {
  const first15Zero = bytes.slice(0, 15).every(byte => byte === 0);
  if (first15Zero && (bytes[15] ?? 0) === 1) return undefined; // ::1 loopback
  if (bytes.every(byte => byte === 0)) return 'unspecified ::';
  // ::ffff:a.b.c.d — the IPv4-mapped form carries a private v4 verbatim.
  if (bytes.slice(0, 10).every(byte => byte === 0) && (bytes[10] ?? 0) === 0xff && (bytes[11] ?? 0) === 0xff) {
    return ipv4BlockedReason([bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0]);
  }
  // ::a.b.c.d — the deprecated IPv4-compatible form is a second such carrier.
  if (bytes.slice(0, 12).every(byte => byte === 0)) {
    return ipv4BlockedReason([bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0]);
  }
  // 64:ff9b::/96 — NAT64 synthesises the embedded v4 on egress.
  if ((bytes[0] ?? 0) === 0x00 && (bytes[1] ?? 0) === 0x64 && (bytes[2] ?? 0) === 0xff && (bytes[3] ?? 0) === 0x9b) {
    return ipv4BlockedReason([bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0]);
  }
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return 'unique-local fc00::/7';
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link-local fe80::/10';
  if ((bytes[0] ?? 0) === 0xff) return 'multicast ff00::/8';
  return undefined;
}

export function blockedReason(host: string): string | undefined {
  const v4 = parseIpv4(host);
  if (v4) return ipv4BlockedReason(v4);
  if (host.includes(':')) {
    const v6 = parseIpv6(host);
    return v6 ? ipv6BlockedReason(v6) : undefined;
  }
  return undefined;
}

/**
 * Validate an outbound URL and return it parsed. Throws OutboundUrlError for a
 * non-http(s) scheme or a target that is not globally reachable, unless the host
 * was explicitly added to the allowlist.
 */
export function assertOutboundUrlAllowed(
  rawUrl: string,
  allowHosts: readonly string[] = parseAllowHosts(process.env.ZEUS_OUTBOUND_ALLOW_HOSTS),
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundUrlError(`outbound URL is not an absolute URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError(`outbound URL must use http or https: ${rawUrl}`);
  }
  const host = normaliseHost(url.hostname);
  if (isAllowlisted(host, allowHosts)) return url;
  const reason = blockedReason(host);
  if (reason) throw new OutboundUrlError(`outbound URL targets a non-public address (${reason}): ${rawUrl}`);
  return url;
}
