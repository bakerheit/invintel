import { zValidator } from "@hono/zod-validator";
import { loginInputSchema, registerInputSchema, type User } from "@invintel/shared";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { isDuplicateKey, type Store, type UserDoc } from "./db.js";

const COOKIE = "invintel_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

export interface AuthOptions {
  allowRegistration: boolean;
  cookieSecure: boolean;
}

export type AuthEnv = { Variables: { user: User } };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const toUser = (u: UserDoc): User => ({
  id: u._id.toHexString(),
  name: u.name,
  email: u.email,
  role: u.role,
});

// Verified against when the email is unknown so response time doesn't reveal which emails exist.
const dummyHash = hash("invintel-dummy-password");

export function createAuth(store: Store, opts: AuthOptions) {
  const failures = new Map<string, { count: number; resetAt: number }>();

  const isLocked = (key: string) => {
    const f = failures.get(key);
    if (!f) return false;
    if (f.resetAt < Date.now()) {
      failures.delete(key);
      return false;
    }
    return f.count >= LOGIN_MAX_FAILURES;
  };
  const recordFailure = (key: string) => {
    const f = failures.get(key);
    if (f && f.resetAt >= Date.now()) f.count++;
    else failures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  };

  async function startSession(c: Parameters<typeof setCookie>[0], userId: ObjectId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await store.sessions.insertOne({
      _id: hashToken(token),
      userId,
      createdAt: new Date(now),
      expiresAt: new Date(now + SESSION_MS),
    });
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: opts.cookieSecure,
      path: "/",
      maxAge: SESSION_MS / 1000,
    });
  }

  const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, COOKIE);
    if (token) {
      const session = await store.sessions.findOne({ _id: hashToken(token) });
      if (session && session.expiresAt > new Date()) {
        const user = await store.users.findOne({ _id: session.userId });
        if (user) {
          c.set("user", toUser(user));
          return next();
        }
      }
    }
    return c.json({ error: "Not signed in" }, 401);
  });

  const routes = new Hono<AuthEnv>();

  routes.get("/config", async (c) =>
    c.json({
      // The first account can always be created so a fresh install is never locked out.
      registrationOpen: opts.allowRegistration || (await store.users.estimatedDocumentCount()) === 0,
    }),
  );

  routes.post("/register", zValidator("json", registerInputSchema), async (c) => {
    const { name, email, password } = c.req.valid("json");
    const userCount = await store.users.estimatedDocumentCount();
    if (!opts.allowRegistration && userCount > 0) {
      return c.json({ error: "Registration is closed" }, 403);
    }
    const doc = {
      _id: new ObjectId(),
      name,
      email,
      passwordHash: await hash(password),
      role: userCount === 0 ? ("admin" as const) : ("member" as const),
      createdAt: new Date(),
    };
    try {
      await store.users.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "An account with that email already exists" }, 409);
      throw e;
    }
    await startSession(c, doc._id);
    return c.json(toUser(doc), 201);
  });

  routes.post("/login", zValidator("json", loginInputSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    if (isLocked(email)) {
      return c.json({ error: "Too many failed attempts. Try again in a few minutes." }, 429);
    }
    const user = await store.users.findOne({ email });
    const ok = await verify(user?.passwordHash ?? (await dummyHash), password).catch(() => false);
    if (!user || !ok) {
      recordFailure(email);
      return c.json({ error: "Invalid email or password" }, 401);
    }
    failures.delete(email);
    await startSession(c, user._id);
    return c.json(toUser(user));
  });

  routes.post("/logout", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await store.sessions.deleteOne({ _id: hashToken(token) });
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  routes.get("/me", requireAuth, (c) => c.json(c.get("user")));

  return { routes, requireAuth };
}
