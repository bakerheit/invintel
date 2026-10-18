import { zValidator } from "@hono/zod-validator";
import {
  loginInputSchema,
  registerInputSchema,
  type RegisterResult,
  type User,
} from "@invintel/shared";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import type { KeyAuth } from "./api-keys.js";
import { isDuplicateKey, type OrgDoc, type Store, type UserDoc } from "./db.js";
import {
  createOrganization,
  findOrgByJoinCode,
  joinOrganization,
  summarizeOrg,
} from "./org-service.js";
import { FailureLimiter } from "./ratelimit.js";

const COOKIE = "invintel_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export interface AuthOptions {
  allowRegistration: boolean;
  cookieSecure: boolean;
  /** Requests a single API key may make per minute. Default 600. */
  apiKeyRatePerMinute?: number;
}

export type AuthEnv = { Variables: { user: User; apiKey?: KeyAuth } };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const toUser = (u: UserDoc): User => ({
  id: u._id.toHexString(),
  name: u.name,
  email: u.email,
});

// Verified against when the email is unknown so response time doesn't reveal which emails exist.
const dummyHash = hash("invintel-dummy-password");

/** Best-effort client address for rate limiting. Behind a proxy this is the proxy's address. */
function clientKey(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createAuth(store: Store, opts: AuthOptions) {
  const loginLimiter = new FailureLimiter(MAX_FAILURES, FAILURE_WINDOW_MS);
  // Wrong join codes at sign-up are limited per client address. The user doesn't exist yet.
  const joinLimiter = new FailureLimiter(MAX_FAILURES, FAILURE_WINDOW_MS);

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
    const { name, email, password, organization } = c.req.valid("json");
    if (!opts.allowRegistration && (await store.users.estimatedDocumentCount()) > 0) {
      return c.json({ error: "Registration is closed" }, 403);
    }

    // Check the join code before creating anything so a typo doesn't leave a half-made account.
    let orgToJoin: OrgDoc | null = null;
    if (organization.mode === "join") {
      const key = clientKey(c);
      if (joinLimiter.isLocked(key)) {
        return c.json({ error: "Too many wrong join codes. Try again in a few minutes." }, 429);
      }
      orgToJoin = await findOrgByJoinCode(store, organization.joinCode);
      if (!orgToJoin) {
        joinLimiter.fail(key);
        return c.json({ error: "That join code isn't valid" }, 400);
      }
    }

    const user: UserDoc = {
      _id: new ObjectId(),
      name,
      email,
      passwordHash: await hash(password),
      createdAt: new Date(),
    };
    try {
      await store.users.insertOne(user);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "An account with that email already exists" }, 409);
      throw e;
    }

    let result: RegisterResult;
    try {
      if (organization.mode === "create") {
        const org = await createOrganization(store, user._id, user.name, organization.name);
        result = { user: toUser(user), organization: await summarizeOrg(store, org, "owner") };
      } else {
        const joined = await joinOrganization(store, user._id, user.name, orgToJoin!, "signed up with the join code");
        result = { user: toUser(user), organization: await summarizeOrg(store, orgToJoin!, joined.role) };
      }
    } catch (e) {
      await store.users.deleteOne({ _id: user._id });
      await store.memberships.deleteMany({ userId: user._id });
      throw e;
    }
    await startSession(c, user._id);
    return c.json(result, 201);
  });

  routes.post("/login", zValidator("json", loginInputSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    if (loginLimiter.isLocked(email)) {
      return c.json({ error: "Too many failed attempts. Try again in a few minutes." }, 429);
    }
    const user = await store.users.findOne({ email });
    const ok = await verify(user?.passwordHash ?? (await dummyHash), password).catch(() => false);
    if (!user || !ok) {
      loginLimiter.fail(email);
      return c.json({ error: "Invalid email or password" }, 401);
    }
    loginLimiter.reset(email);
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
