import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

/**
 * Signing for documents exchanged between Invintel organizations.
 * Each organization has an Ed25519 key pair. A message is signed over a canonical form (sorted keys, no whitespace),
 * so the same content always produces the same bytes no matter how it was built or re-serialized in transit.
 */

/** JSON with sorted keys, so the signature doesn't depend on key order. Undefined fields are dropped, as JSON.stringify would. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface KeyPair {
  /** Base64 of the SPKI DER public key. Safe to share. */
  publicKey: string;
  /** Base64 of the PKCS8 DER private key. Never leaves the server; stored sealed when a secret is configured. */
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** A short fingerprint people can read out to each other to check they hold the same key: first 20 hex of SHA-256, in groups of 4. */
export const fingerprint = (publicKey: string) =>
  createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 20).replace(/(.{4})/g, "$1 ").trim();

export function signPayload(payload: unknown, privateKeyB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(canonicalJson(payload)), key).toString("base64");
}

export function verifyPayload(payload: unknown, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * Sealing the private key at rest. With a secret (EXCHANGE_KEY_SECRET) the key is stored as AES-256-GCM ("v1:iv:tag:data");
 * without one it is stored as-is, which is fine for a demo and says so in the README.
 */
const keyFrom = (secret: string) => createHash("sha256").update(`invintel-exchange:${secret}`).digest();

export function sealKey(privateKeyB64: string, secret: string | undefined): string {
  if (!secret) return privateKeyB64;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([c.update(privateKeyB64, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function openKey(stored: string, secret: string | undefined): string {
  if (!stored.startsWith("v1:")) return stored;
  if (!secret) throw new Error("This key is sealed. Set EXCHANGE_KEY_SECRET to the secret it was sealed with.");
  const [, iv, tag, data] = stored.split(":") as [string, string, string, string];
  const d = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

/** Messages older or newer than this (clock skew included) are refused, which bounds how long a captured message could be replayed. */
export const REPLAY_WINDOW_MS = 10 * 60_000;
export const withinWindow = (createdAt: string, now = Date.now()) => {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && Math.abs(now - t) <= REPLAY_WINDOW_MS;
};
