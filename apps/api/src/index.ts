import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp(createDb());

serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`invintel api listening on http://localhost:${port}`);
});
