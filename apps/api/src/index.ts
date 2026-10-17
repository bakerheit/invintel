import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { connect } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
const store = await connect();
const app = createApp(store, {
  allowRegistration: process.env.ALLOW_REGISTRATION !== "false",
  cookieSecure: process.env.COOKIE_SECURE === "true",
});

const server = serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`invintel api listening on http://localhost:${port}`);
});

const shutdown = () => {
  server.close();
  void store.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
