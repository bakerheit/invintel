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

Open http://localhost:5173 and create an account. The first account becomes the admin. Indexes are created on API startup.

### Auth

- Email + password, hashed with argon2id.
- Sessions are an opaque random token in an `httpOnly`, `SameSite=Lax` cookie. Only a SHA-256 of the token is stored in Mongo, and sessions expire after 7 days (TTL index).
- Failed logins are rate limited per email (10 per 15 minutes, in memory, so it resets on restart and isn't shared across instances).
- Set `ALLOW_REGISTRATION=false` to close sign-ups once your team is in. The very first account can always register.
- Set `COOKIE_SECURE=true` when serving over HTTPS.
- All `/api/items` routes need a session. All signed-in users share one inventory for now.

## Scripts

- `pnpm dev` run API and web together
- `pnpm typecheck` typecheck every package
- `pnpm test` run the API tests (Vitest, needs `docker compose up -d`; uses a throwaway database)
- `pnpm build` typecheck the API and build the web app

## API

Auth routes (no session needed except `/me`):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/auth/config` | `{ registrationOpen }` |
| POST   | `/api/auth/register` | `{ name, email, password }`, signs you in |
| POST   | `/api/auth/login` | `{ email, password }` |
| POST   | `/api/auth/logout` | ends the session |
| GET    | `/api/auth/me` | current user |

Inventory routes (session required):

| Method | Path | |
| ------ | ---- | - |
| GET    | `/api/items` | list items |
| POST   | `/api/items` | create (logs initial stock) |
| GET    | `/api/items/:id` | get one |
| PATCH  | `/api/items/:id` | update details (quantity is ignored; use adjust) |
| DELETE | `/api/items/:id` | delete item and its history |
| POST   | `/api/items/:id/adjust` | `{ delta, reason }`, can't go below 0 |
| GET    | `/api/items/:id/movements` | stock history |

## License

MIT
