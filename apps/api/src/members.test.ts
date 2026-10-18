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
async function signUp(organization: object, name: string) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `m${++n}@example.com`, password: "correct horse", organization }),
  });
  const body = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, id: body.user.id as string, org: body.organization };
}
const send = (cookie: string, path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("members", () => {
  it("owner promotes and demotes; admins and members can't change roles", async () => {
    const owner = await signUp({ mode: "create", name: "Acme" }, "Owner");
    const a = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Alice");
    const b = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
    const base = `/api/orgs/${owner.org.id}/members`;

    expect((await send(a.cookie, `${base}/${b.id}`, "PATCH", { role: "admin" })).status).toBe(403);
    expect((await send(owner.cookie, `${base}/${a.id}`, "PATCH", { role: "admin" })).status).toBe(200);
    // An admin still can't change roles.
    expect((await send(a.cookie, `${base}/${b.id}`, "PATCH", { role: "admin" })).status).toBe(403);
    const list = await (await send(owner.cookie, base, "GET")).json();
    expect(list.find((m: { userId: string }) => m.userId === a.id).role).toBe("admin");
    // Admins now see the join code and can use admin routes.
    expect((await send(a.cookie, `/api/orgs/${owner.org.id}/join-code`, "POST")).status).toBe(200);
    expect((await send(owner.cookie, `${base}/${a.id}`, "PATCH", { role: "member" })).status).toBe(200);
    expect((await send(a.cookie, `/api/orgs/${owner.org.id}/join-code`, "POST")).status).toBe(403);
  });

  it("protects the owner and enforces who may remove whom", async () => {
    const owner = await signUp({ mode: "create", name: "Acme" }, "Owner");
    const admin = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Admin");
    const m1 = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "M1");
    const m2 = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "M2");
    const base = `/api/orgs/${owner.org.id}/members`;
    await send(owner.cookie, `${base}/${admin.id}`, "PATCH", { role: "admin" });

    expect((await send(owner.cookie, `${base}/${owner.id}`, "PATCH", { role: "member" })).status).toBe(409);
    expect((await send(owner.cookie, `${base}/${owner.id}`, "DELETE")).status).toBe(409);
    expect((await send(admin.cookie, `${base}/${owner.id}`, "DELETE")).status).toBe(409);
    expect((await send(m1.cookie, `${base}/${m2.id}`, "DELETE")).status).toBe(403);
    expect((await send(admin.cookie, `${base}/${owner.id}x`, "DELETE")).status).toBe(400);
    expect((await send(admin.cookie, `${base}/${m2.id}`, "DELETE")).status).toBe(204);
    // Admins can't remove admins; the owner can.
    const admin2 = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Admin2");
    await send(owner.cookie, `${base}/${admin2.id}`, "PATCH", { role: "admin" });
    expect((await send(admin.cookie, `${base}/${admin2.id}`, "DELETE")).status).toBe(403);
    expect((await send(owner.cookie, `${base}/${admin2.id}`, "DELETE")).status).toBe(204);
    // A member can leave on their own; afterwards the org is a 404 for them.
    expect((await send(m1.cookie, `${base}/${m1.id}`, "DELETE")).status).toBe(204);
    expect((await send(m1.cookie, `/api/orgs/${owner.org.id}/overview`, "GET")).status).toBe(404);
    // Every change is in the audit log.
    const log = await (await send(owner.cookie, `/api/orgs/${owner.org.id}/audit?limit=100`, "GET")).json();
    const actions = log.events.map((e: { action: string }) => e.action).filter((a: string) => a !== "member.joined" && a !== "organization.created");
    expect(actions.sort()).toEqual(["member.left", "member.removed", "member.removed", "member.role_changed", "member.role_changed"].sort());
  });
});
