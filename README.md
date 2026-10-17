# Invintel

Open source inventory management, built by Bakerheit Technologies.

## Stack

| Layer    | Tech |
| -------- | ---- |
| Frontend | Vite, React 19, TypeScript, Zustand, shadcn/ui (Tailwind v4), TanStack Table, TanStack Query |
| Backend  | Hono, MongoDB (official driver), argon2 password hashing, Zod |
| Shared   | `@invintel/shared`: Zod schemas and types used by both sides |

pnpm workspace layout:

```
apps/api         Hono REST API + MongoDB
apps/web         Vite React app
packages/shared  Zod schemas + shared types
```

## Getting started

```bash
cp .env.example .env     # optional, defaults work for local dev
docker compose up -d     # MongoDB on localhost:27017
pnpm install
pnpm dev                 # api on :3001, web on :5173 (proxies /api)
```

Open http://localhost:5173 and create an account. At sign-up you either **create an organization** or **join one with a code** (a radio toggle swaps the organization name field for a join code field). Indexes are created on API startup.

### Organizations, locations and stock

- A user can belong to several organizations and switch between them from the header. "Create or join another…" adds more.
- Everything is scoped to an organization: items, locations, stock and history live under `/api/orgs/:orgId/…`. Non-members get a 404, and the same SKU can exist in two organizations.
- Roles: **owner** (whoever created it), **admin**, **member**. Joining by code makes you a member. Admins and owners can add, rename and delete locations, see and rotate the join code, and rename the organization. Members can manage inventory and read everything else. (There's no UI yet to promote members to admin.)
- Every new organization starts with one location called "Main".
- Stock is tracked per item per location. An item's quantity is the sum across locations. You can adjust stock at a location, move stock between locations, and filter the inventory table by location.
- A location can't be deleted while it still holds stock.
- Join codes are 8 characters (no look-alike letters), shown as `ABCD-EFGH`. Rotating one invalidates the old code. Wrong guesses are rate limited.
- Stock history records who made each change.

### Auth

- Email + password, hashed with argon2id.
- Sessions are an opaque random token in an `httpOnly`, `SameSite=Lax` cookie. Only a SHA-256 of the token is stored in Mongo, and sessions expire after 7 days (TTL index).
- Failed logins are rate limited per email, and wrong join codes per client address / user (10 per 15 minutes, in memory, so it resets on restart and isn't shared across instances).
- Set `ALLOW_REGISTRATION=false` to close sign-ups once your team is in. The very first account can always register.
- Set `COOKIE_SECURE=true` when serving over HTTPS.

## Scripts

- `pnpm dev` run API and web together
- `API_URL=http://localhost:3002 pnpm --filter @invintel/web dev` point the web dev server at a different API (default `http://localhost:3001`)
- `pnpm typecheck` typecheck every package
- `pnpm test` run the API tests (Vitest, needs `docker compose up -d`; uses a throwaway database)
- `pnpm build` typecheck the API and build the web app

## API

Auth (no session needed except `/me`):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/auth/config` | `{ registrationOpen }` |
| POST   | `/api/auth/register` | `{ name, email, password, organization }` where `organization` is `{ mode: "create", name }` or `{ mode: "join", joinCode }` |
| POST   | `/api/auth/login` | `{ email, password }` |
| POST   | `/api/auth/logout` | ends the session |
| GET    | `/api/auth/me` | current user |

Organizations (session required):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/orgs` | your organizations and roles |
| POST   | `/api/orgs` | `{ name }`, you become the owner |
| POST   | `/api/orgs/join` | `{ joinCode }` |
| GET    | `/api/orgs/:orgId` | one organization (join code only for admins) |
| PATCH  | `/api/orgs/:orgId` | rename (admin) |
| POST   | `/api/orgs/:orgId/join-code` | rotate the join code (admin) |
| GET    | `/api/orgs/:orgId/members` | members and roles |

Under `/api/orgs/:orgId` (members only):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/locations` | locations with item and unit counts |
| POST   | `/locations` | create (admin) |
| PATCH  | `/locations/:id` | edit (admin) |
| DELETE | `/locations/:id` | delete, refused while it holds stock (admin) |
| GET    | `/items` | items with total quantity and per-location stock |
| POST   | `/items` | create, optional `initialStock: { locationId, quantity }` |
| GET    | `/items/:id` | get one |
| PATCH  | `/items/:id` | update details (stock changes go through adjust/transfer) |
| DELETE | `/items/:id` | delete item and its history |
| POST   | `/items/:id/adjust` | `{ locationId, delta, reason }`, can't go below 0 at that location |
| POST   | `/items/:id/transfer` | `{ fromLocationId, toLocationId, quantity, reason }` |
| GET    | `/items/:id/movements` | stock history |

## License

MIT
