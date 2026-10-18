import { registerDocContextLoader } from "./doc-context.js";
import { createExchangeInboxRoutes, registerInvintelExchange } from "./exchange.js";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { createAuth, type AuthEnv, type AuthOptions } from "./auth.js";
import type { Store } from "./db.js";
import { createKeyAuth } from "./api-keys.js";
import { createB2BPortalRoutes } from "./b2b-orders.js";
import { createB2BInboundRoutes } from "./b2b-routes.js";
import { createOrgRoutes } from "./orgs.js";
import { listenForEvents } from "./webhooks.js";

export function createApp(store: Store, authOptions: AuthOptions) {
  const app = new Hono();
  const auth = createAuth(store, authOptions);
  registerDocContextLoader(store); // bridges draw their PDFs with the organization's letterhead and templates

  app.use("*", logger());
  // No CORS: the web app talks to the API same-origin (Vite proxies /api in dev).

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", auth.routes);
  // Partners post documents here without a session; each partner's bridge verifies the request itself.
  app.route("/api/b2b/inbound", createB2BInboundRoutes(store));
  // A supplier answers an order here with the private link from the email (no account).
  app.route("/api/b2b/portal", createB2BPortalRoutes(store));
  // Invintel partners deliver signed documents here; the signature, not a session, is what is checked.
  app.route("/api/exchange", createExchangeInboxRoutes(store));
  registerInvintelExchange(store);

  // Webhooks hear about every audit event as it is written.
  listenForEvents(store);

  // Everything else needs a session, or an API key. Inventory lives under /api/orgs/:orgId.
  const api = new Hono<AuthEnv>();
  const keyAuth = createKeyAuth(store, { perMinute: authOptions.apiKeyRatePerMinute });
  api.use("*", async (c, next) => {
    if (!c.req.header("authorization")) return auth.requireAuth(c, next);
    // A key is for one organization's inventory, and for nothing else (not listing or creating organizations).
    if (!/^\/api\/orgs\/[0-9a-f]{24}(\/|$)/i.test(c.req.path)) return c.json({ error: "This API key isn't allowed to do that" }, 403);
    return keyAuth(c as never, next);
  });
  api.route("/orgs", createOrgRoutes(store));
  app.route("/api", api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
