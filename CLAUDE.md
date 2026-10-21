# CLAUDE.md

## What this repo is
A small, runnable proof of a zero-downtime migration from Firestore (FlutterFlow app) to Node.js/TypeScript (Fastify) + PostgreSQL, using a driving-school bookings domain. The full spec, phases and acceptance criteria are in **MASTER_PLAN.md**. That file is the source of truth.

## How to work
- Work **one phase at a time** from MASTER_PLAN.md §12. At the end of each phase:
  1. Tick the checkbox in MASTER_PLAN.md.
  2. Summarise what changed: files and key decisions.
  3. Show the commands you ran and their output (`pnpm typecheck`, `pnpm lint`, `pnpm test`).
  4. **Stop and wait for "go"** before starting the next phase.
- Before writing code for a phase, give a short plan (5–10 bullets). Proceed unless something is ambiguous.
- If the spec is ambiguous or seems wrong, ask. Don't silently invent behaviour.
- **Ask before adding any dependency** that isn't listed in MASTER_PLAN.md §1.
- Never mark a phase done if typecheck, lint or tests fail.

## Commands
```
pnpm db:up / db:down / db:migrate / db:reset
pnpm emulator          # Firestore emulator, project demo-driving-school (UI on :4000)
pnpm seed --target=emulator|json|firestore
pnpm backfill [--source=emulator|firestore|json] [--dry-run] [--resume] [--batch-size=500]
pnpm reconcile [--source=...]
pnpm sync              # live listener → Postgres
pnpm dev               # Fastify API
pnpm test | test:unit | test:int
pnpm typecheck | lint
pnpm demo              # scripts/demo.sh, full run from scratch
```

## Code conventions
- TypeScript `strict`, ESM, named exports. No `any`; use `unknown` and narrow it with zod.
- Normalisers in `src/normalize/` are **pure functions** that return `NormalizeResult` (ok + warnings, or reject + reason code). No I/O in there.
- All DB access goes through `src/db/` (Kysely/pg). Raw SQL is fine where it's clearer (upserts, savepoints, exclusion handling).
- SQL migrations are **append-only**. Never edit a migration that has already been applied; add a new one.
- Reason and warning codes are string-literal unions in one place (`src/normalize/result.ts`). Tests assert on them.
- Small files, small functions, descriptive names. Comment the *why*, not the *what*.
- Timestamps: always `timestamptz`, UTC inside the code, Europe/Rome only when parsing Italian local strings.
- Money: integer cents everywhere.

## Testing
- Every normaliser has table-driven unit tests covering the fixtures in MASTER_PLAN.md §3.2.
- Integration tests use the JSON source (no emulator needed) and the Postgres at `TEST_DATABASE_URL`: the compose DB locally, a service container in CI. Each test file gets a throwaway `ds_test_*` database cloned from a migrated template. No Testcontainers: Docker may be a remote host.
- Must-have integration tests:
  - idempotency (second backfill run: all unchanged)
  - resume after a crash
  - the exclusion constraint (overlap / adjacent / cancelled)
  - reconciliation detecting a mutation
  - sync newer-wins
  - API returning 409 on overlap

## Security and GDPR
- **Never commit credentials.** A service-account JSON stays outside the repo (`GOOGLE_APPLICATION_CREDENTIALS`), and `.gitignore` covers `*service-account*.json` and `.env`.
- Never log PII. pino `redact` (`src/logger.ts`) covers contact details, tax codes, names and free-text notes in camelCase and snake_case, the authorization header and pg error details. It is a safety net: never log whole documents or rows.
- Reconciliation and shadow-diff output show **legacy ids and field names only**, never values.
- `migration_rejects.payload` holds raw docs (PII). Treat it as restricted, and say so in the docs.

## Git
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), one commit per meaningful step, at least one per phase.
