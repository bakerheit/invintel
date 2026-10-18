import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Webhooks make this server call addresses that an admin typed in. Left alone, that lets anyone with an admin
 * login reach things only the server can: the cloud metadata service, the database, other services on the
 * same network. So an address is only used if it is a public one, checked when it is saved AND again every time
 * a connection is made (a name can point somewhere harmless today and somewhere private tomorrow).
 */

export class BlockedAddressError extends Error {}

/** Both are for development and tests only, and off unless the environment says so. */
export const webhookPolicy = () => ({
  timeoutMs: Number(process.env.INVINTEL_WEBHOOK_TIMEOUT_MS) || 8000,
  allowPrivate: process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE === "true",
  allowHttp: process.env.INVINTEL_WEBHOOKS_ALLOW_HTTP === "true" || process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE === "true",
});

type Range = [bigint, number]; // network address, prefix length

const v4 = (s: string): bigint => s.split(".").reduce((n, p) => (n << 8n) + BigInt(p), 0n);
const V4_BLOCKED: Range[] = (
  [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, including the cloud metadata address 169.254.169.254
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, and broadcast
  ] as [string, number][]
).map(([a, p]) => [v4(a), p]);

const inRange = (value: bigint, [net_, prefix]: Range, bits: number) => value >> BigInt(bits - prefix) === net_ >> BigInt(bits - prefix);

/** Eight 16-bit groups of an IPv6 address as one number, or null if it isn't one. */
function parseV6(raw: string): bigint | null {
  let s = raw.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A dotted IPv4 tail (::ffff:10.0.0.1) is two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (net.isIPv4(tail[1]!) === false) return null;
    const n = v4(tail[1]!);
    s = s.slice(0, -tail[1]!.length) + ((n >> 16n) & 0xffffn).toString(16) + ":" + (n & 0xffffn).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...rest];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) + BigInt(`0x${g}`);
  }
  return value;
}

const V6_BLOCKED: Range[] = (
  [
    ["::", 128], // unspecified
    ["::1", 128], // loopback
    ["64:ff9b::", 96], // NAT64 (carries an IPv4 address, checked separately below too)
    ["64:ff9b:1::", 48], // local-use NAT64
    ["100::", 64], // discard
    ["2001::", 23], // protocol assignments, including Teredo
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4
    ["3fff::", 20], // documentation
    ["fc00::", 7], // unique local (private)
    ["fe80::", 10], // link-local
    ["fec0::", 10], // site-local (retired, still private)
    ["ff00::", 8], // multicast
  ] as [string, number][]
).map(([a, p]) => [parseV6(a)!, p]);

/** True only for an address that is on the public internet. Anything unclear is not public. */
export function isPublicIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const n = v4(address);
    return !V4_BLOCKED.some((r) => inRange(n, r, 32));
  }
  if (net.isIPv6(address)) {
    const n = parseV6(address);
    if (n === null) return false;
    // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) all reach the IPv4 address.
    const high = n >> 32n;
    if (high === 0xffffn || high === 0n || n >> 32n === 0x64ff9b0000000000000000n) return isPublicIp(`${Number((n >> 24n) & 255n)}.${Number((n >> 16n) & 255n)}.${Number((n >> 8n) & 255n)}.${Number(n & 255n)}`);
    if (V6_BLOCKED.some((r) => inRange(n, r, 128))) return false;
    return n >> 125n === 1n; // global unicast is 2000::/3; nothing else is fair game
  }
  return false;
}

const BLOCKED_NAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.localdomain$/, /\.lan$/, /\.home$/, /\.corp$/, /^metadata$/];

/** Checks an address typed into the form. Says what is wrong in words, or returns the parsed URL. */
export function validateWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  const policy = webhookPolicy();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That isn't a web address. Use something like https://example.com/hooks/invintel" };
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return { ok: false, error: "Webhooks need an https:// address, so what is sent can't be read on the way." };
  }
  if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { ok: false, error: "The address has no host name." };
  if (!policy.allowPrivate) {
    if (BLOCKED_NAMES.some((re) => re.test(host))) return { ok: false, error: "That name points inside a private network. Webhooks can only go to public addresses." };
    if (net.isIP(host) && !isPublicIp(host)) return { ok: false, error: "That is a private or reserved address. Webhooks can only go to public addresses." };
    // Looks like a number but isn't a normal one (http://2130706433/, http://0x7f.1/): the URL parser has already turned
    // those into dotted form, so anything still all-digits-and-dots that isn't a valid IP is refused.
    if (/^[\d.x]+$/i.test(host) && !net.isIP(host)) return { ok: false, error: "That isn't a valid address." };
  }
  return { ok: true, url };
}

export interface PostResult {
  status: number;
  /** The start of the answer, for the log. */
  snippet: string;
}

/**
 * POSTs to a webhook address. Every address the name resolves to is checked at the moment of connecting, redirects
 * are never followed (a public server could otherwise bounce the request to a private one), and only a few
 * kilobytes of the answer are read.
 */
export function postJson(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PostResult> {
  const policy = webhookPolicy();
  const check = validateWebhookUrl(rawUrl);
  if (!check.ok) return Promise.reject(new BlockedAddressError(check.error));
  const url = check.url;
  const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
  const maxBytes = opts.maxBytes ?? 4096;

  const lookup = ((hostname: string, options: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err, "", 4);
      const list = addrs as dns.LookupAddress[];
      const bad = policy.allowPrivate ? undefined : list.find((a) => !isPublicIp(a.address));
      if (bad || !list.length) return cb(new BlockedAddressError(`${hostname} points at a private address, so nothing was sent.`), "", 4);
      if (options.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as net.LookupFunction;

  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "POST",
        agent: false,
        lookup,
        timeout: timeoutMs,
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)), "user-agent": "Invintel-Webhooks/1" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
          else res.destroy(); // enough to know what it said
        });
        const finish = () => resolve({ status: res.statusCode ?? 0, snippet: Buffer.concat(chunks).toString("utf8").slice(0, 300) });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    // A literal IP never goes through lookup, so it is checked here.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (!policy.allowPrivate && net.isIP(literal) && !isPublicIp(literal)) {
      req.destroy();
      return reject(new BlockedAddressError("That is a private or reserved address, so nothing was sent."));
    }
    req.on("timeout", () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds`)));
    req.on("error", reject);
    req.end(body);
  });
}
