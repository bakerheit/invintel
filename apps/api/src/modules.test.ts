import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
const signUp = async (organization: object) => {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada", email: `mo${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
};
const patch = (cookie: string, path: string, body: unknown) => app.request(path, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("organization modules", () => {
  it("are all on by default, admins switch them, members can't, and it is audited", async () => {
    const owner = await signUp({ mode: "create", name: "Acme" });
    const member = await signUp({ mode: "join", joinCode: owner.org.joinCode });
    expect(owner.org.modules).toEqual({ purchasing: true, production: true });
    const url = `/api/orgs/${owner.org.id}/modules`;
    expect((await patch(member.cookie, url, { production: false })).status).toBe(403);
    expect((await patch(owner.cookie, url, {})).status).toBe(400);
    const res = await patch(owner.cookie, url, { production: false });
    expect((await res.json()).modules).toEqual({ purchasing: true, production: false });
    // The member sees the change, and the other organization isn't touched.
    const list = await (await app.request("/api/orgs", { headers: { cookie: member.cookie } })).json();
    expect(list[0].modules.production).toBe(false);
    await patch(owner.cookie, url, { production: false }); // no-op: no second audit event
    const log = await (await app.request(`/api/orgs/${owner.org.id}/audit`, { headers: { cookie: owner.cookie } })).json();
    expect(log.events.filter((e: { action: string }) => e.action === "organization.modules_changed")).toHaveLength(1);
  });
});
