import { Hono } from "hono";
import { logger } from "hono/logger";
import { createAuth, type AuthEnv, type AuthOptions } from "./auth.js";
import type { Store } from "./db.js";
import { createOrgRoutes } from "./orgs.js";

export function createApp(store: Store, authOptions: AuthOptions) {
  const app = new Hono();
  const auth = createAuth(store, authOptions);

  app.use("*", logger());
  // No CORS: the web app talks to the API same-origin (Vite proxies /api in dev).

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", auth.routes);

  // Everything else needs a session. Inventory lives under /api/orgs/:orgId.
  const api = new Hono<AuthEnv>();
  api.use("*", auth.requireAuth);
  api.route("/orgs", createOrgRoutes(store));
  app.route("/api", api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
