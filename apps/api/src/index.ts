import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { connect } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
// Loopback only by default: the API is reached through the Vite dev proxy or nginx, never directly from the network.
// Set HOST=0.0.0.0 only if you really want it open on every interface.
const hostname = process.env.HOST ?? "127.0.0.1";
const store = await connect();
const app = createApp(store, {
  allowRegistration: process.env.ALLOW_REGISTRATION !== "false",
  cookieSecure: process.env.COOKIE_SECURE === "true",
});

const server = serve({ fetch: app.fetch, port, hostname }, ({ port }) => {
  console.log(`invintel api listening on http://${hostname}:${port}`);
});

const shutdown = () => {
  server.close();
  void store.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
