# Invintel

Open source inventory management, built by Bakerheit Technologies.

## Stack

| Layer    | Tech |
| -------- | ---- |
| Frontend | Vite, React 19, TypeScript, Zustand, shadcn/ui (Tailwind v4), TanStack Table, TanStack Query |
| Backend  | Hono, Drizzle ORM, SQLite (better-sqlite3), Zod |
| Shared   | `@invintel/shared`: Zod schemas and types used by both sides |

pnpm workspace layout:

```
apps/api         Hono REST API + SQLite
apps/web         Vite React app
packages/shared  Zod schemas + shared types
```

## Getting started

```bash
pnpm install
pnpm dev        # api on :3001, web on :5173 (proxies /api)
```

Open http://localhost:5173. The SQLite file lives in `data/invintel.db` and migrations run on API startup.

## Scripts

- `pnpm dev` run API and web together
- `pnpm typecheck` typecheck every package
- `pnpm test` run the API tests (Vitest, in-memory SQLite)
- `pnpm build` typecheck the API and build the web app
- `pnpm --filter @invintel/api db:generate` generate a migration after editing `apps/api/src/schema.ts`

## API

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
