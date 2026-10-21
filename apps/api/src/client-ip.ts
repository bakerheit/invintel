import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import net from "node:net";

/** Is this the machine itself? (Where a reverse proxy on the same host connects from.) */
export const isLoopback = (address: string | undefined): boolean =>
  !!address && (address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address));

/**
 * The address of whoever is really on the other end. Behind nginx every request arrives from 127.0.0.1, so
 * limits keyed on the socket address would treat the whole world as one visitor: one bad actor could lock
 * everyone out. nginx sets X-Real-IP to the visitor's address, so that header is believed, but ONLY when the
 * connection itself comes from the same machine. From anywhere else the header is just something the sender
 * typed, and is ignored.
 */
export function pickClientIp(peer: string | undefined, realIp: string | undefined): string {
  if (!isLoopback(peer)) return peer ?? "unknown";
  const claimed = realIp?.trim();
  return claimed && net.isIP(claimed) ? claimed.toLowerCase() : (peer ?? "unknown");
}

export function clientIp(c: Context): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    peer = undefined;
  }
  return pickClientIp(peer, c.req.header("x-real-ip"));
}
