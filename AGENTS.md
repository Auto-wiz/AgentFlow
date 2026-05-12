# AgentFlow

## Cursor Cloud specific instructions

### Overview

AgentFlow is an npm workspaces monorepo (4 workspaces: `apps/api`, `apps/web`, `packages/db`, `packages/shared`). See `README.md` for the full stack description.

### Running services

- **API Worker** (`apps/api`): `npm run dev -w @agentflow/api` — runs `wrangler dev` on `http://localhost:8787`. Requires `apps/api/.dev.vars` with at minimum a `DATABASE_URL`. Cloudflare Queues are emulated locally by Wrangler.
- **Web frontend** (`apps/web`): `NEXT_PUBLIC_API_BASE_URL=http://localhost:8787 npm run dev -w @agentflow/web` — Next.js dev server on `http://localhost:3000`. The env var must be set before starting so the client-side code knows the API origin.

### Validation commands

- `npm run check` — TypeScript type-check all workspaces
- `npm run build` — build all workspaces (dry-run deploy for API, `next build` for web)

### Key gotchas

- The API Worker uses `.dev.vars` (not `.env`) for local secrets — Wrangler reads this file automatically. Do not commit real secrets.
- Without a real Neon Postgres `DATABASE_URL`, endpoints that hit the database (`/threads`, `/threads/:id/messages`, webhook persistence) will return 500. The `/health`, `/webhooks/gohighlevel` (GET), and `/oauth/gohighlevel/start` endpoints work without a database.
- There are no automated test suites in this repo yet. Validation is via `npm run check` (type-check) and `npm run build`.
- `GHL_WEBHOOK_SECRET` can be left empty for local dev — all webhooks will be accepted without signature verification.
