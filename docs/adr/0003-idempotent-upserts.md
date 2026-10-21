# ADR 0003: Idempotent upserts where the newer version wins

- **Status:** accepted
- **Date:** 2026-10-21

## Context

Postgres is filled from Firestore by two writers at once:
- **The backfill** copies everything. It can be re-run, and resumed after a crash.
- **The live sync** applies each change as it happens. In production its triggers deliver **at least once**, and not necessarily in order.

To leave no gap, the sync starts *before* the backfill. So the same document can arrive from both, in any order, more than once. Whatever arrives last must not undo a newer change.

## Decision

Every migrated row stores `legacy_updated_at`, the Firestore `updateTime` of the version it came from. Every write, from either writer, is the same upsert:

```sql
insert into bookings (...) values (...)
on conflict (legacy_id) do update set ..., legacy_updated_at = excluded.legacy_updated_at
where bookings.legacy_updated_at is null
   or bookings.legacy_updated_at < excluded.legacy_updated_at
returning legacy_id, (xmax = 0) as inserted;
```

- **An older or equal version changes nothing:** the WHERE skips it, and no row comes back. We count that as *unchanged*.
- **A newer version updates the row.** `xmax = 0` tells an insert (true) from an update (false), so a run can report inserted, updated and unchanged.
- **One rule for both writers.** The backfill and the sync go through the same code path (`src/migrate/apply.ts`).
- **Merged students** use the newest `updateTime` of all their sign-ups, so an edit to any duplicate counts as a change.
- **Status history** goes into `booking_events` with `on conflict do nothing` on `(booking_id, status, occurred_at)`, so replays add nothing.

## Why not "update when different"

The first draft of the plan updated whenever `legacy_updated_at` was **different**. With the sync running first, that loses data:
1. The backfill reads a booking at 10:00.
2. A user edits it at 10:01, and the sync writes the new version.
3. The backfill then writes its 10:00 copy over it.

"Is distinct from" accepts the older copy; "is older than" doesn't. We changed the rule before writing any code.

## Consequences

- **Re-running the backfill is safe and cheap.** The second run reports every row unchanged. A test asserts it, and that a crash at two different points resumes to exactly the same tables.
- **Duplicate and out-of-order sync events are harmless.** A test applies a newer version, then the original, and the newer data stays.
- **A fix to a normalisation rule doesn't reach rows already imported** unless their source doc changes. Re-applying a rule needs a deliberate `--force` (planned, not built), which keeps that kind of rewrite visible.
- **Deletes carry no `updateTime`.** A removed doc becomes `deleted_at = now()`, and only `students` and `bookings` can be soft-deleted. Re-creating a doc with a newer version brings it back.
- **The comparison relies on Firestore's own `updateTime`,** not on client clocks, so devices with wrong clocks can't win.
