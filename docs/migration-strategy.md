# Migration strategy: Firestore → Postgres

How the driving-school product moves from FlutterFlow + Firestore to a Node.js API + PostgreSQL **without downtime and without losing data**. Every phase below has an entry criterion, an exit criterion and a rollback. No phase is a one-way door until the last one.

**The principle:** Firestore stays the source of truth until Postgres has been proven equal, first in data (reconciliation), then in behaviour (shadow reads). Users never notice a switch, because each switch is one screen behind one setting.

---

## Phase 0: Prepare

The schema, backfill and reconciliation exist and run in CI on every change.

- **Postgres** runs in an EU region: Cloud SQL in `europe-west8` (Milan), close to the users and inside the EU for GDPR.
- **Built in this repo:**
  - the schema, with the no-double-booking constraint
  - the normalisers and the backfill
  - reconciliation
  - the CI that runs all of them
- **Entry:** the target schema is agreed, and the data-quality rules are signed off by product. See [data-quality-decisions.md](data-quality-decisions.md).
- **Exit:** a dry run against a copy of production finishes, and the rejects report has been reviewed.
- **Rollback:** nothing to roll back; production is untouched.

## Phase 1: Mirror

Firestore remains the only thing the app touches. Postgres is filled behind it, and kept filled.

1. Start the sync worker **first**. It doesn't replay the state at start, only changes after it.
2. Run the backfill. The state at start is exactly what the backfill copies, so no change falls between the two.
3. Changes that arrive during the backfill are harmless: the newer version always wins ([ADR 0003](adr/0003-idempotent-upserts.md)).
4. Run reconciliation nightly. Its exit code goes to alerting.

- **Entry:** Phase 0 is done; the sync worker is deployed with a dead-letter topic.
- **Exit:** reconciliation is clean for 7 nights in a row; the dead-letter topic stays empty, or every message in it is explained.
- **Rollback:** stop the sync worker. Nothing reads Postgres yet.

## Phase 2: Shadow reads

The API exists. Screens that already call it run with `BOOKINGS_READ_SOURCE=shadow`:
1. The API reads both stores and serves Firestore.
2. Each difference is logged as `shadow_diff`, with the legacy id and field names only.
3. `/debug/shadow-stats` counts the differences per field, which becomes the to-do list.

- **Entry:** reconciliation is clean, and the API is deployed behind the existing auth.
- **Exit:** zero `shadow_diff` for N days (we suggest 7) on real traffic, for each screen that will switch.
- **Rollback:** set the flag back to `firestore`. Shadow mode never changes what users see.

## Phase 3: Read cutover, screen by screen

Each FlutterFlow screen is rewired from a direct Firestore query to an API call, then moved from `shadow` to `postgres`, one at a time, starting with the least critical (an instructor's weekly view, say).

- **Entry:** the screen has been diff-free in shadow mode. Support knows the switch is happening.
- **Exit:** every read screen is on Postgres, and error rates and latencies are unchanged.
- **Rollback:** flip that screen's flag back to `firestore`. That takes seconds; no deploy is needed.

## Phase 4: Write cutover

Writes move to `POST /v1/bookings` and friends, so Postgres becomes the source of truth for bookings. Two new rules hold from here:
- **Writes now go into Postgres first.** The exclusion constraint answers `409 BOOKING_OVERLAP` to the app, even when two requests race.
- **Old app versions still read Firestore directly**, so a **reverse sync** keeps Firestore updated. It uses a transactional outbox: the write and an outbox row commit together, and a worker copies outbox rows to Firestore. Old versions see new bookings until they're gone.

- **Entry:** every read is on Postgres; the reverse sync is tested, including deletes and the outbox's retry behaviour.
- **Exit:** every write goes through the API; reconciliation (now Postgres → Firestore) is clean nightly.
- **Rollback:** point writes back at Firestore and turn the forward sync on again. The outbox replays anything written in between. This rollback is rehearsed in staging before go-live.

## Phase 5: Decommission

1. Set a **minimum supported app version** with Firebase Remote Config, and force older apps to update.
2. When the share of old versions is ~0: stop the reverse sync, make Firestore read-only (security rules deny writes), and keep it for a few weeks as a reference.
3. Export Firestore to cold storage, then delete the project.
4. Purge `migration_rejects.payload` (see GDPR).

- **Entry:** old-version traffic is below an agreed threshold (for example 0.5% of sessions for 14 days).
- **Exit:** the Firestore project is archived and deleted.
- **Rollback:** before deletion, turn Firestore writable again and turn the reverse sync back on.

---

## FlutterFlow specifics

- **Screens bound to Firestore must be rewired.** FlutterFlow screens are usually bound **directly** to Firestore queries and documents. Each such screen has to be rewired to an API call (an API Call backend query), which is the bulk of the client work in Phase 3. Plan it screen by screen, and pair the API developer with the FlutterFlow owner.
- **Old app versions can't be rewired.** Builds already in the App Store and Play Store keep reading and writing Firestore until users update. That's why Phase 4 needs the reverse sync, and Phase 5 the forced update.
- **The FlutterFlow schema doesn't protect the data.** Its schema editor describes collections for the app builder; Firestore doesn't enforce it. The messy data in this repo (text dates, `"Cancelled"` vs `"canceled"`, duplicate accounts) is exactly what such apps accumulate.
- **Auth stays Firebase Auth throughout.** The API verifies Firebase ID tokens, so users never log in again. Moving auth is a separate project.

## Team split (4–5 developers)

A Kanban board with WIP limits: at most 2 items in progress per person, and at most 3 items in review across the team.

| Who | Owns |
|---|---|
| 1 dev | Schema and backfill: migrations, normalisers, rejects review with ops |
| 1 dev | Sync pipeline and reverse sync: triggers → Pub/Sub → worker, dead letters, outbox |
| 1–2 devs | API and per-screen cutover, **paired with whoever owns the FlutterFlow app** |
| 1 dev | Reconciliation, observability and QA: nightly gate, dashboards, shadow-diff triage |
| Tech lead | ADRs, reviews, the cutover runbook, and the go/no-go at each phase exit |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A change is lost between the backfill and the sync | Start the sync first; newer-wins makes the overlap safe; nightly reconciliation catches anything else |
| Duplicate or out-of-order trigger deliveries | Every write is an idempotent, newer-wins upsert ([ADR 0003](adr/0003-idempotent-upserts.md)) |
| Existing double bookings block the import | They're rejected with the conflicting booking named; ops resolves them from the report |
| Two app users book the same slot at the same moment | The exclusion constraint decides atomically, and the loser gets 409 ([ADR 0002](adr/0002-exclusion-constraint.md)) |
| A data rule is wrong | Every rule is a pure function with tests; fix it and re-run with `--force` (a planned flag) |
| Old app versions write to Firestore after the write cutover | The forward sync stays on until the forced update; the reverse sync covers reads |
| Postgres is slower than Firestore for some screen | Shadow mode measures both; that screen stays on Firestore until it's tuned |
| Personal data leaks through logs or reports | Redaction in the logger; reports and diffs carry ids and field names only |
| Sync worker falls behind or dies | Dead-letter topic plus an alert, and the nightly reconciliation as backstop |

## Rough timeline

For a team of 4–5. Phases overlap where they can.

| Phase | Duration |
|---|---|
| 0 Prepare | 2–3 weeks |
| 1 Mirror | 2 weeks (mostly waiting for clean nights) |
| 2 Shadow | 2–4 weeks |
| 3 Read cutover | 4–6 weeks, depending on the number of screens |
| 4 Write cutover | 3–4 weeks |
| 5 Decommission | 4–8 weeks, set by how fast old app versions disappear |

That is roughly **4–6 months** end to end, with users never seeing downtime.

## GDPR

- **EU data residency.** Postgres runs in an EU region (`europe-west8` Milan), like the Firestore data it replaces. Backups stay in the EU too.
- **Data minimisation.**
  - Postgres doesn't copy the denormalised names (`studentName`, `instructorName`, `cityName`). It keeps only the foreign keys, so a name lives in one place.
  - The API doesn't return names on bookings.
- **Logs.**
  - The logger hides emails, phones, tax codes, names and free-text notes, in both naming styles.
  - It also hides the authorization header, and the database's error details, which can contain row values.
  - Reconciliation and shadow-diff output show legacy ids and field names, never values.
- **`migration_rejects.payload`** holds raw source documents, which is personal data.
  - Restrict the table to the migration team.
  - Use it only to resolve rejects.
  - **Purge it after cutover** (Phase 5).
- **Records of processing** must be updated: a new processor (the Postgres host), a new location, a new retention rule for the rejects. The DPO signs this off before Phase 1.
- **Erasure requests during the dual run** must reach **both** stores.
  - Delete in Firestore. The sync turns that into `deleted_at` in Postgres, so the row stops counting immediately.
  - Then run a scheduled hard delete of personal fields in Postgres, for erasure-flagged rows.
  - Any `migration_rejects` rows for that person are deleted too.
