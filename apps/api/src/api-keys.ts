import { zValidator } from "@hono/zod-validator";
import { API_KEY_PREFIX, apiKeyInputSchema, objectIdSchema, type ApiKey, type ApiKeyCreated, type ApiScope } from "@invintel/shared";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import type { ApiKeyDoc, Store } from "./db.js";
import { clientIp } from "./client-ip.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { FailureLimiter } from "./ratelimit.js";

/** What a request made with an API key carries, set by the key middleware and read by the organization middleware. */
export interface KeyAuth {
  id: string;
  orgId: string;
  scope: ApiScope;
}

const MAX_KEYS = 50;
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key: "ivk_" and 32 random bytes. Returned once; only its hash is kept. */
export function newKey() {
  const secret = randomBytes(32).toString("base64url");
  const key = `${API_KEY_PREFIX}${secret}`;
  return { key, prefix: secret.slice(0, 8), hash: hashKey(key) };
}

export const toApiKey = (k: ApiKeyDoc): ApiKey => ({
  id: k._id.toHexString(),
  name: k.name,
  scope: k.scope,
  prefix: `${API_KEY_PREFIX}${k.prefix}…`,
  createdAt: k.createdAt.toISOString(),
  createdBy: k.createdBy.name,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  expiresAt: k.expiresAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
});

// ---------------- what a key may do ----------------

const ID = "[0-9a-f]{24}";
const re = (s: string) => new RegExp(`^${s}$`, "i");

/** Reading: look things up. */
const READ_PATHS = [
  re(`/items(/${ID}(/movements)?)?`),
  re(`/locations(/${ID})?`),
  re("/movements"),
  re("/overview"),
  re(`/units(/${ID})?`),
  re("/lookup"),
  re(`/purchasing/(suppliers|orders|suggestions)(/${ID})?`),
  re(`/counts(/${ID})?`),
];

/** Writing: the everyday things a connected system does. Never a delete, an import, a restore, or anything about people and settings. */
const WRITE_PATHS: [string, RegExp][] = [
  ["POST", re("/items")],
  ["PATCH", re(`/items/${ID}`)],
  ["POST", re(`/items/${ID}/(adjust|transfer)`)],
  ["POST", re("/units")],
  ["POST", re(`/units/${ID}/(move|adjust)`)],
  ["POST", re("/(receipts|moves)")],
  ["POST", re(`/purchasing/orders/${ID}/receive`)],
];

/** Does a key with this scope get to make this request? `path` is what follows /api/orgs/:orgId. */
export function keyPermits(scope: ApiScope, method: string, path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (method === "GET" || method === "HEAD") return READ_PATHS.some((r) => r.test(p));
  return scope === "write" && WRITE_PATHS.some(([m, r]) => m === method && r.test(p));
}

// ---------------- using a key ----------------

const WINDOW_MS = 60_000;

/**
 * Signs requests in with `Authorization: Bearer ivk_...`. Anything else falls through to the cookie session.
 * A wrong key looks the same as a missing one, and repeated wrong keys from one address are slowed down.
 */
export function createKeyAuth(store: Store, opts: { perMinute?: number } = {}) {
  const perMinute = opts.perMinute ?? 600;
  const wrong = new FailureLimiter(20, 15 * 60_000);
  const windows = new Map<string, { count: number; resetAt: number }>();

  return createMiddleware<{ Variables: { user: { id: string; name: string; email: string }; apiKey?: KeyAuth } }>(async (c, next) => {
    const header = c.req.header("authorization");
    const match = header ? /^Bearer\s+(ivk_[A-Za-z0-9_-]{20,100})$/i.exec(header.trim()) : null;
    if (!match) return c.json({ error: "Not signed in" }, 401);
    const address = clientIp(c);
    if (wrong.isLocked(address)) return c.json({ error: "Too many wrong keys. Try again in a few minutes." }, 429);

    const key = match[1]!;
    const candidates = await store.apiKeys.find({ prefix: key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8) }).toArray();
    const given = Buffer.from(hashKey(key), "hex");
    const doc = candidates.find((k) => {
      const have = Buffer.from(k.hash, "hex");
      return have.length === given.length && timingSafeEqual(have, given);
    });
    const now = new Date();
    if (!doc || doc.revokedAt || (doc.expiresAt && doc.expiresAt <= now)) {
      wrong.fail(address);
      return c.json({ error: "Not signed in" }, 401);
    }

    const w = windows.get(doc._id.toHexString());
    if (!w || w.resetAt <= Date.now()) windows.set(doc._id.toHexString(), { count: 1, resetAt: Date.now() + WINDOW_MS });
    else if (++w.count > perMinute) {
      c.header("retry-after", String(Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000))));
      return c.json({ error: "Too many requests with this key. Slow down." }, 429);
    }

    // Recorded at most once a minute, so a busy integration doesn't write on every request.
    if (!doc.lastUsedAt || now.getTime() - doc.lastUsedAt.getTime() > 60_000) {
      void store.apiKeys.updateOne({ _id: doc._id }, { $set: { lastUsedAt: now } }).catch(() => {});
    }
    // The key acts as a member who is named after it, so the ledger and audit log say which key did something.
    c.set("user", { id: doc._id.toHexString(), name: `API key: ${doc.name}`, email: "" });
    c.set("apiKey", { id: doc._id.toHexString(), orgId: doc.orgId.toHexString(), scope: doc.scope });
    await next();
  });
}

// ---------------- managing keys (people only, never keys) ----------------

const idParam = z.object({ id: objectIdSchema });

export function createApiKeyRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  r.use("*", requireRole("admin"));

  r.get("/", async (c) => {
    const docs = await store.apiKeys.find({ orgId: c.get("org")._id }).sort({ createdAt: -1 }).limit(200).toArray();
    return c.json(docs.map(toApiKey));
  });

  r.post("/", zValidator("json", apiKeyInputSchema), async (c) => {
    const org = c.get("org");
    const input = c.req.valid("json");
    if ((await store.apiKeys.countDocuments({ orgId: org._id, revokedAt: { $exists: false } })) >= MAX_KEYS) {
      return c.json({ error: `An organization can have ${MAX_KEYS} active keys. Revoke one you don't use first.` }, 409);
    }
    const { key, prefix, hash } = newKey();
    const me = c.get("user");
    const now = new Date();
    const doc: ApiKeyDoc = {
      _id: new ObjectId(), orgId: org._id, name: input.name, scope: input.scope, prefix, hash,
      createdBy: { id: new ObjectId(me.id), name: me.name }, createdAt: now,
      ...(input.expiresInDays ? { expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000) } : {}),
    };
    await store.apiKeys.insertOne(doc);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "api_key.created",
      entity: { type: "organization", id: org._id.toHexString(), label: `API key ${input.name}` },
      // The key itself is a password, so only its name, scope and first characters are written down.
      summary: `Created the ${input.scope} API key "${input.name}" (${API_KEY_PREFIX}${prefix}…)${doc.expiresAt ? `, expires ${doc.expiresAt.toISOString().slice(0, 10)}` : ""}`,
      refs: { apiKeyId: doc._id.toHexString() },
    });
    return c.json<ApiKeyCreated>({ ...toApiKey(doc), key }, 201);
  });

  /** Stops a key working right away. The record stays, so the log still says what it was. */
  r.post("/:id/revoke", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const doc = await store.apiKeys.findOneAndUpdate(
      { _id: new ObjectId(c.req.valid("param").id), orgId: org._id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!doc) return c.json({ error: "Key not found, or already revoked" }, 404);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "api_key.revoked",
      entity: { type: "organization", id: org._id.toHexString(), label: `API key ${doc.name}` },
      summary: `Revoked the API key "${doc.name}" (${API_KEY_PREFIX}${doc.prefix}…)`,
      refs: { apiKeyId: doc._id.toHexString() },
    });
    return c.json(toApiKey(doc));
  });

  return r;
}
