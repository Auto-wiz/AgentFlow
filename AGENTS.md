# AgentFlow

## Cursor Cloud specific instructions

### Overview

AgentFlow is a monorepo (npm workspaces) with four packages:

| Workspace | Path | Dev command |
|---|---|---|
| `@agentflow/api` | `apps/api` | `npm run dev -w @agentflow/api` (wrangler dev on :8787) |
| `@agentflow/web` | `apps/web` | `npm run dev -w @agentflow/web` (next dev on :3000) |
| `@agentflow/db` | `packages/db` | No dev server; schema + migrations only |
| `@agentflow/shared` | `packages/shared` | No dev server; shared TS types only |

### Lint / Check / Build

- `npm run check` — runs `tsc --noEmit` across all workspaces (the only lint step).
- `npm run build` — runs build across all workspaces (wrangler dry-run for API, next build for web).
- There are no separate ESLint or Prettier configs in this repo.

### Running the dev servers

1. **API**: `npm run dev -w @agentflow/api` — starts wrangler dev on `http://localhost:8787`. Cloudflare Queues are emulated locally by wrangler.
2. **Web**: `NEXT_PUBLIC_API_BASE_URL=http://localhost:8787 npm run dev -w @agentflow/web` — starts Next.js on `http://localhost:3000`. The env var points the frontend at the local API.

### Gotchas

- The API worker requires `DATABASE_URL` (Neon Postgres connection string) for any database operations. Without it, webhook processing will accept but fail to persist (`queued: false`). The `/health` and `/webhooks/gohighlevel` GET endpoints work without a database.
- There is no `.env` auto-loading for the wrangler dev server. Secrets must be configured via wrangler or passed as env vars. For local development, you can create a `.dev.vars` file in `apps/api/` with `DATABASE_URL=...`.
- The `NEXT_PUBLIC_API_BASE_URL` env var must be set **before** starting the Next.js dev server (it's baked in at build/start time for client components).
- No automated tests exist in this repo. Validation relies on `npm run check` (TypeScript) and `npm run build`.
- Database migrations are managed via `npm run db:generate -w @agentflow/db` and `npm run db:migrate -w @agentflow/db`, requiring `DATABASE_URL` in the environment.
