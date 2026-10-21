# ADR 0002: Prevent double bookings with an exclusion constraint, not app-level checks

- **Status:** accepted
- **Date:** 2026-10-21

## Context

An instructor must never have two active lessons at the same time, and neither must a student. Today the app checks this before saving, and the data shows it isn't enough: there are existing double bookings (fixtures `bk_overlap_a` / `bk_overlap_b`).

An app-level check is "read, then write". Two requests that arrive together can both read "free" and both write. Old app versions run older checks, or none.

## Decision

Make the database the guarantee:

```sql
constraint bookings_no_instructor_overlap exclude using gist (
  instructor_id with =,
  tstzrange(starts_at, ends_at, '[)') with &&
) where (deleted_at is null and status in ('booked','confirmed'))
-- and the same on student_id
```

- **`[)` half-open ranges.** A lesson ending at 11:00 and one starting at 11:00 don't overlap, so back-to-back lessons work (`bk_adjacent_1/2`).
- **Partial.** Only `booked` and `confirmed` lessons that aren't deleted block. A cancelled or completed lesson, or a deleted one, never does (`bk_overlap_cancelled`, `bk_deleted`).
- **`btree_gist`** lets a GiST index use `=` on a uuid, so the instructor and the time range sit in one index.
- **Atomic.** Postgres checks it inside the insert or update, under concurrency. Of two racing requests, exactly one wins.

How violations surface:
- **In the backfill,** SQLSTATE `23P01` becomes a reject (`OVERLAP_INSTRUCTOR` or `OVERLAP_STUDENT`, from the constraint name) that names the booking already holding the slot. The first one stored wins, and ops resolves the rest.
- **In the API,** `23P01` becomes `409 BOOKING_OVERLAP`.

## The `ends_at` gotcha

It's tempting to store only `starts_at` and the duration, and make `ends_at` a generated column, `starts_at + make_interval(mins => duration)`. **Postgres rejects that:** `timestamptz + interval` is only *STABLE*, not *IMMUTABLE*. Adding "1 day" depends on the session's time zone across a clock change, and generated columns and index expressions require IMMUTABLE functions.

So:
- the normaliser computes `ends_at`
- `check (ends_at > starts_at)` and `check (ends_at - starts_at between interval '15 minutes' and interval '4 hours')` protect it, so a wrong `ends_at` can never be stored

## Consequences

- **Double bookings are impossible** for every client: the new API, old app versions writing through sync, and manual SQL.
- **The rule lives in one place,** and it's tested directly (`test/integration/schema.test.ts`):
  - overlap → `23P01`
  - adjacent, cancelled, completed, no-show or deleted → accepted
- **Writers must handle `23P01` cleanly.** The backfill's split-and-retry writer and the API's error mapping do.
- **Importing existing double bookings needs a rule** for which one wins: "first stored", with the others rejected and named. Ops reviews them.

## Alternatives considered

- **App-level check before insert.** Loses races, and old clients skip it.
- **`SERIALIZABLE` transactions.** Correct in theory, but every booking write must retry on serialization failures, and the rule is implicit in code instead of visible in the schema.
- **Advisory locks per instructor.** Every writer must take them in the right order. One forgotten code path, or one manual SQL session, breaks the rule.
- **A unique index on (instructor, slot).** Only works if lessons fit fixed slots. Ours have different lengths (30–120 minutes) and start times.
