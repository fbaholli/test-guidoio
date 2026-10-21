# MASTER_PLAN — Firestore → Postgres migration proof (driving-school bookings)

## 0. Goal

Build a small, runnable proof of how to migrate a FlutterFlow + Firestore product to Node.js (TypeScript, Fastify) + PostgreSQL **without downtime and without losing data**. The domain is a driving school: cities, pickup points, instructors, students and lesson bookings.

It must demonstrate, end to end:

1. A realistic **messy Firestore dataset**: text dates, typos in statuses, duplicated students, orphans and double-bookings.
2. A **normalised Postgres schema** that makes bad states impossible. The headline is a database-level guarantee that an instructor (or student) can never have two overlapping active lessons.
3. A **batched, resumable, idempotent backfill**. Bad records go to a rejects table with a reason instead of crashing the run.
4. **Reconciliation** that proves Firestore and Postgres match (counts plus per-record checksums), with a non-zero exit code on mismatch so it can gate a cutover.
5. **Live sync** of Firestore changes into Postgres, where the newer version wins (safe against duplicate and out-of-order events).
6. A **Fastify API** with a per-route read-source flag (`firestore | postgres | shadow`), so screens can be switched over one at a time. This is the strangler-fig approach.
7. **Docs** covering the phased migration strategy, FlutterFlow and old-app-version concerns, the team split, GDPR, and the data-quality decisions.

This is a portfolio proof, not production code. Keep it small, readable and well tested. Where a production version would differ, say so in a short "Production note".

**Priority if time is short:** Phases 0–5 plus Phase 8 are must-have. Phases 6–7 are strongly wanted. Stretch goals are optional.

---

## 1. Tech stack (use these unless there is a strong reason not to; ask before adding other deps)

- Node.js 22 LTS, TypeScript `strict`, ESM, pnpm
- `tsx` to run TS scripts, `vitest` for tests, `biome` for lint and format
- Postgres 16 via `docker compose`, with extensions `btree_gist` and `pgcrypto`
- `pg` plus `kysely` for typed queries. Migrations are **plain SQL files** in `db/migrations/`, applied by a tiny runner (`src/db/migrate.ts`) that records them in a `schema_migrations` table.
- `firebase-admin` for Firestore. By default it runs against the **Firestore emulator** with project id `demo-driving-school`. The `demo-` prefix means no real project and no credentials are needed. Optional real-project mode uses `GOOGLE_APPLICATION_CREDENTIALS`. The emulator comes from `firebase-tools` and needs a JDK installed. Check the required Java version in the firebase-tools docs and note it in the README prerequisites. Set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` so the Admin SDK talks to the emulator.
- `fastify` v5, `zod` plus `fastify-type-provider-zod` for request/response schemas, `pino` logging with redaction
- `luxon` for dates and time zones (Europe/Rome, DST-aware), `libphonenumber-js` for phones
- `@faker-js/faker` with a **fixed seed** for deterministic data
- Integration tests use the Postgres at `TEST_DATABASE_URL`: the compose DB locally, a `postgres:16` service container in CI. Each test file gets a throwaway `ds_test_*` database cloned from a migrated template. No Testcontainers: Docker may run on another machine (a remote Docker context), which it doesn't support.

---

## 2. Repository layout

```
.
├── CLAUDE.md
├── MASTER_PLAN.md
├── README.md
├── docker-compose.yml            # postgres:16
├── firebase.json                 # emulator config (firestore on 8080, UI on 4000)
├── .env.example
├── package.json  pnpm-workspace.yaml  tsconfig.json  vitest.config.ts  biome.json  .gitignore
├── .github/workflows/ci.yml
├── db/migrations/
│   ├── 001_extensions.sql
│   ├── 002_core_tables.sql
│   ├── 003_bookings.sql
│   └── 004_migration_bookkeeping.sql
├── src/
│   ├── config.ts                 # zod-validated env
│   ├── logger.ts                 # pino + redact paths
│   ├── db/{pool.ts,kysely.ts,migrate.ts,reset.ts,types.ts,errors.ts}
│   ├── source/
│   │   ├── types.ts              # SourceReader interface, RawDoc type
│   │   ├── collections.ts        # collection names in FK order
│   │   ├── export-format.ts      # JSON export shape + zod schema ($timestamp wrapper)
│   │   ├── firestore-client.ts   # Admin SDK connection, emulator vs real-project guards
│   │   ├── firestore-emulator.ts # emulator REST helpers (health check, clear)
│   │   ├── firestore-reader.ts   # paginated by documentId, exposes updateTime
│   │   └── json-reader.ts        # reads fixtures/export.json (same interface)
│   ├── seed/
│   │   ├── calendar.ts  reference-data.ts  generate.ts  fixtures.ts  dataset.ts  types.ts
│   │   └── args.ts  json-export.ts  firestore-writer.ts
│   ├── util/order.ts             # code-unit order = Firestore document-id order
│   ├── normalize/
│   │   ├── dates.ts  status.ts  phone.ts  money.ts  email.ts
│   │   ├── students.ts  instructors.ts  bookings.ts  cities.ts  pickup-points.ts
│   │   ├── context.ts  fields.ts  license.ts  schemas.ts (strict output shapes)
│   │   ├── source-context.ts     # lookups built from source docs alone (tests, Firestore reads)
│   │   └── result.ts             # NormalizeResult = { ok, value, warnings[] } | { ok:false, reason, detail }
│   ├── migrate/
│   │   ├── backfill.ts  upsert.ts  rejects.ts  warnings.ts  checkpoints.ts
│   │   ├── apply.ts              # normalise → write → record; shared by backfill and sync
│   │   ├── write-rows.ts  explain-booking.ts  runs.ts  stats.ts
│   │   ├── id-map.ts             # legacy_id → uuid lookups
│   │   ├── report.ts             # console table + reports/run-<id>.{md,json}
│   │   ├── reconcile.ts  canonical.ts (canonical JSON + sha256)
│   │   └── sync.ts               # syncDocument() shared by listener + backfill
│   ├── api/
│   │   ├── app.ts  errors.ts     # PG error → HTTP mapping
│   │   ├── routes/bookings.ts
│   │   └── repos/{types.ts,postgres.ts,firestore.ts,shadow.ts}
│   └── cli/{run-cli.ts,migrate.ts,db-reset.ts,seed.ts,backfill.ts,reconcile.ts,sync.ts,serve.ts}
├── test/{unit/,integration/,fixtures/,support/}   # integration/global-setup.ts migrates the template DB
├── scripts/demo.sh               # runs the whole demo from a fresh clone
├── reports/                      # gitignored run reports
└── docs/
    ├── migration-strategy.md
    ├── data-quality-decisions.md
    └── adr/0001-postgres.md  0002-exclusion-constraint.md  0003-idempotent-upserts.md
```

`package.json` scripts: `db:up`, `db:down`, `db:migrate`, `db:reset`, `emulator`, `seed`, `backfill`, `reconcile`, `sync`, `dev`, `test`, `test:unit`, `test:int`, `typecheck`, `lint`, `demo`.

---

## 3. Source data model (Firestore, deliberately messy)

Collections (top-level):

| Collection | Fields (as found in the wild) |
|---|---|
| `cities/{id}` | `name`, `region` |
| `pickupPoints/{id}` | `cityId`, `name`, `address`, `lat`, `lng` |
| `instructors/{id}` | `fullName`, `email`, `phone`, `cityId`, `licenseCategories: string[]`, `active` |
| `students/{id}` | `firstName`, `lastName`, `email`, `phone`, `taxCode` (codice fiscale, optional), `cityId`, `licenseCategory`, `createdAt`, `deleted?` |
| `bookings/{id}` | `studentId`, `instructorId`, `pickupPointId`, `startAt`, `durationMin`, `status`, `price`, `paid`, **denormalised** `studentName`, `instructorName`, `cityName`, `history: [{status, at, by}]`, `notes`, `deleted?`, `createdAt` |

Every source doc also carries `updateTime` (from the Firestore snapshot; `_updateTime` in the JSON export). It is used as `legacy_updated_at` for change detection and newer-wins logic.

**JSON export format** (`test/fixtures/export.json`, written by `pnpm seed --target=json`): `{ "collections": { "<name>": [{ "id", "_updateTime", "data" }] } }`, with the collections in FK order and the docs in id order. JSON has no timestamp type, so a Firestore `Timestamp` is written as `{ "$timestamp": "<ISO UTC>" }`. Other values are kept exactly as they are, so the string and number date fixtures stay strings and numbers. Every doc gets the same `_updateTime`: the dataset snapshot, 2026-10-19 07:00 Europe/Rome. The file is committed, and a unit test fails if it no longer matches the seed.

### 3.1 Seed volume (deterministic, `faker.seed(42)`)

3 cities (Milano, Roma, Torino), 12 pickup points, 15 instructors, 300 students (about 3% duplicates by email), about 2,000 bookings spread over 8 weeks. The generated "normal" data is mostly clean. All the interesting cases come from the **known-bad fixtures** below.

- The fixture instructors and students in §3.2 come on top of these counts (4 instructors, 16 students).
- Lessons run Monday to Saturday, 08:00–20:00 Rome time. Lessons that ended before the snapshot (2026-10-19 07:00 Europe/Rome) are `completed`, `no_show` or `cancelled`; later ones are `booked`, `confirmed` or `cancelled`. `history` always ends with the current status.
- The 8-week window starts on a **fixed date**, Monday 2026-09-07, never "now". Faker's date helpers default to today, so always pass the reference date. Otherwise `export.json` would change every day.
- Generated bookings sit on a **non-overlapping slot grid** for each instructor and each student. The generator itself never creates an overlap.
- Generated bookings copy the denormalised names **exactly** (`studentName` = `firstName + " " + lastName`, `instructorName` = `fullName`, `cityName` = the city's `name`), so `bk_denorm_drift` is the only booking that triggers `DENORM_DRIFT`.

### 3.2 Known-bad fixtures (fixed IDs; tests assert on these)

Fixture design rules, so each fixture lands in exactly one predictable outcome:

- Fixtures use a **dedicated pool** of instructors and students (`in_fx_*`, `st_fx_*`, plus the student fixtures `st_dup_rossi_*`, `st_bad_phone` and `st_phone_formats_*`). Generated bookings never use them. Fixtures that aren't meant to clash either have different instructors and students or don't overlap in time.
- The backfill reads in document-id order, so in an overlap **the booking stored first wins**. Ids compare character by character, so the booking meant to win must have the id that sorts first. For example, `bk_overlap_a` < `bk_overlap_b`, and `bk_student_overlap` clashes with `bk_student_base`, which sorts before it.
- `bk_overlap_a` and `bk_overlap_b` have **different students**, so only the instructor constraint can fire.
- `bk_date_timestamp`, `bk_date_iso`, `bk_date_it_string` and `bk_date_epoch` are **the same instant** on purpose: 2026-10-21 14:30 Europe/Rome, which is 12:30Z. A unit test asserts that the four formats give one moment. They use different instructors and students, so they don't overlap each other.

| Doc id | Problem | Expected outcome |
|---|---|---|
| `st_dup_rossi_a` / `st_dup_rossi_b` | Same person, emails `" Mario.Rossi@Example.com"` vs `"mario.rossi@example.com"` | **Merged** into one student (oldest `createdAt` is canonical, gaps filled from the other). Both legacy ids go in `legacy_id_map`. Warning `DUPLICATE_MERGED`. |
| `st_bad_phone` | phone `"chiamami dopo le 18"` | Imported with `phone_e164 = null`, warning `PHONE_UNPARSEABLE` |
| `st_phone_formats_*` | `"333 123 4567"`, `"0039 333-123-4567"`, `"+393331234567"` | All become `+393331234567`, warning `PHONE_NORMALIZED` where changed |
| `bk_orphan_student` | `studentId: "st_does_not_exist"` | **Reject** `ORPHAN_STUDENT` |
| `bk_orphan_instructor` | unknown `instructorId` | **Reject** `ORPHAN_INSTRUCTOR` |
| `bk_overlap_a` + `bk_overlap_b` | Same instructor, overlapping by 30 min, both `confirmed` | `a` imported. `b` **rejected** `OVERLAP_INSTRUCTOR`, with the detail naming `bk_overlap_a`. **No automatic winner picking beyond first-in**: ops resolves it from the rejects report. |
| `bk_overlap_cancelled` | Overlaps `bk_overlap_a` but status `cancelled` | Imported (cancelled lessons don't block) |
| `bk_adjacent_1` / `bk_adjacent_2` | 10:00–11:00 and 11:00–12:00, same instructor | Both imported (half-open ranges `[)`) |
| `bk_student_base` + `bk_student_overlap` | Same student in two lessons at once, different instructors | `bk_student_base` imported. `bk_student_overlap` **rejected** `OVERLAP_STUDENT`, with the detail naming `bk_student_base` |
| `bk_date_timestamp` | `startAt` is a Firestore Timestamp | Imported |
| `bk_date_iso` | `"2026-10-21T14:30:00+02:00"` | Imported |
| `bk_date_it_string` | `"21/10/2026 14:30"` (Italian local time) | Parsed as Europe/Rome, warning `DATE_PARSED_FROM_STRING` |
| `bk_date_epoch` | `1792585800000` (millis) | Imported, warning `DATE_PARSED_FROM_NUMBER` |
| `bk_date_garbage` | `"domani pomeriggio"` | **Reject** `INVALID_DATE` |
| `bk_dst_gap` | `"29/03/2026 02:30"` (does not exist in Europe/Rome) | **Reject** `DST_GAP` |
| `bk_dst_ambiguous` | `"25/10/2026 02:30"` (happens twice in Europe/Rome: summer time, then winter time) | Imported as the first occurrence (02:30 CEST = 00:30Z), warning `DATE_AMBIGUOUS` |
| `bk_status_variants_*` | `"Cancelled"`, `"canceled"`, `" CONFIRMED "`, `"noshow"` | Mapped to the canonical status, warning `STATUS_NORMALIZED` |
| `bk_status_unknown` | `"rescheduled"` | **Reject** `INVALID_STATUS`. The decisions doc says "needs product decision". |
| `bk_no_duration` | `durationMin` missing | Default 60, warning `DURATION_DEFAULTED` |
| `bk_bad_duration` | `durationMin: 600` | **Reject** `INVALID_DURATION` (allowed 15–240) |
| `bk_price_string` | `price: "45,50"` | `price_cents = 4550`, warning `PRICE_PARSED_FROM_STRING` |
| `bk_denorm_drift` | `studentName: "Mario R."` ≠ student doc | Imported. Postgres keeps only the FK, never the copied name. Warning `DENORM_DRIFT`. |
| `bk_dup_student_ref` | `studentId: "st_dup_rossi_b"` | Resolves to the **merged** student via `legacy_id_map` |
| `bk_history_nested` | `history` with 3 status changes | 3 rows in `booking_events`. A re-run must not duplicate them. |
| `bk_deleted` | `deleted: true` | Imported with `deleted_at` set; doesn't block overlaps |
| `bk_unknown_fields` | extra fields `legacyFlag`, `tmp2` | Imported; warning `UNKNOWN_FIELDS` listing the field names |

### 3.3 Other reason and warning codes

These cases have no seed fixture. The normalisers' table-driven unit tests cover them. All codes from §3.2 and §3.3 live in `src/normalize/result.ts`.

| Case | Outcome | Code |
|---|---|---|
| Price negative or unreadable (`"gratis"`) | **Reject** | `INVALID_PRICE` |
| Price missing | Imported with `price_cents = null` | warning `PRICE_MISSING` |
| Booking's `pickupPointId` unknown | Imported with `pickup_point_id = null`: the lesson matters more than the pickup point | warning `ORPHAN_PICKUP_POINT` |
| Pickup point's or instructor's `cityId` unknown | **Reject**, because `city_id` is `not null`. Rejecting an instructor also rejects their bookings as `ORPHAN_INSTRUCTOR` | `ORPHAN_CITY` |
| Student's `cityId` unknown | Imported with `city_id = null` | warning `CITY_UNKNOWN` |
| `taxCode` malformed after trimming and uppercasing | Imported with `tax_code = null` | warning `TAX_CODE_INVALID` |
| `licenseCategory` unknown after uppercasing (`"b"` → `"B"`) | Imported with `license_category = null`. For an instructor's `licenseCategories`, only the unknown entry is dropped | warning `LICENSE_CATEGORY_INVALID` |
| Required field missing (no `studentId`, no `lastName`, …) | **Reject**, with the detail naming the field | `MISSING_REQUIRED_FIELD` |
| *Added in Phase 3:* a value no rule above covers fails the strict output schema (e.g. `paid: "yes"`) | **Reject**, with the detail naming the field paths, never the values | `INVALID_RECORD` |
| *Added in Phase 3:* pickup point `lat`/`lng` missing on one side or out of range | Imported with both set to `null`: half a location is no use | warning `COORDINATES_INVALID` |
| *Added in Phase 3:* a `history` entry without a readable status or time | That entry is dropped; the booking and its other events import | warning `HISTORY_ENTRY_DROPPED` |

---

## 4. Target schema (Postgres)

Rules: UUID primary keys (`gen_random_uuid()`), `legacy_id text unique not null` on every migrated table, `created_at`/`updated_at timestamptz not null default now()`, an `updated_at` trigger, all timestamps in UTC (`timestamptz`), and money as integer cents.

```sql
-- 001_extensions.sql
create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- needed for uuid "=" inside a GiST exclusion constraint

-- 002_core_tables.sql
create table cities (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  name text not null,
  region text,
  legacy_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pickup_points (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  city_id uuid not null references cities(id),
  name text not null,
  address text,
  lat numeric(9,6) check (lat between -90 and 90),
  lng numeric(9,6) check (lng between -180 and 180),
  legacy_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table instructors (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  city_id uuid not null references cities(id),
  full_name text not null,
  email text,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  license_categories text[] not null default '{}',
  active boolean not null default true,
  legacy_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table students (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,          -- canonical legacy id (others in legacy_id_map)
  city_id uuid references cities(id),
  first_name text not null,
  last_name text not null,
  email text,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  tax_code text check (tax_code ~ '^[A-Z0-9]{16}$'),
  license_category text check (license_category in ('AM','A1','A2','A','B')),
  deleted_at timestamptz,
  legacy_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index students_email_active_uq
  on students (lower(email)) where email is not null and deleted_at is null;

create table legacy_id_map (
  entity text not null,                    -- 'student' | 'instructor' | ...
  legacy_id text not null,
  new_id uuid not null,
  primary key (entity, legacy_id)
);

-- 003_bookings.sql
create table bookings (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  student_id uuid not null references students(id),
  instructor_id uuid not null references instructors(id),
  pickup_point_id uuid references pickup_points(id),
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  status text not null check (status in ('booked','confirmed','completed','cancelled','no_show')),
  price_cents integer check (price_cents >= 0),
  paid boolean not null default false,
  notes text,
  deleted_at timestamptz,
  source text not null default 'firestore',   -- 'firestore' | 'api'
  legacy_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at between interval '15 minutes' and interval '4 hours'),

  -- THE headline guarantee: no overlapping active lessons per instructor / per student
  constraint bookings_no_instructor_overlap exclude using gist (
    instructor_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (deleted_at is null and status in ('booked','confirmed')),
  constraint bookings_no_student_overlap exclude using gist (
    student_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (deleted_at is null and status in ('booked','confirmed'))
);
create index bookings_instructor_starts_idx on bookings (instructor_id, starts_at);
create index bookings_student_starts_idx on bookings (student_id, starts_at);

create table booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  status text not null,
  occurred_at timestamptz not null,
  actor text,
  source text not null default 'firestore',
  unique (booking_id, status, occurred_at)   -- makes re-runs idempotent
);

-- 004_migration_bookkeeping.sql
create table migration_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('backfill','sync','reconcile')),
  source text not null,                     -- 'emulator' | 'firestore' | 'json'
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'
);
create table migration_checkpoints (
  run_id uuid not null references migration_runs(id),
  collection text not null,
  last_doc_id text not null,
  updated_at timestamptz not null default now(),
  primary key (run_id, collection)
);
create table migration_rejects (
  id bigint generated always as identity primary key,
  run_id uuid not null references migration_runs(id),
  entity text not null,
  legacy_id text not null,
  reason_code text not null,
  reason_detail text,
  payload jsonb not null,                   -- raw source doc (PII: access-restricted table)
  created_at timestamptz not null default now(),
  unique (run_id, entity, legacy_id)
);
create table migration_warnings (
  id bigint generated always as identity primary key,
  run_id uuid not null references migration_runs(id),
  entity text not null,
  legacy_id text not null,
  code text not null,
  detail text,
  created_at timestamptz not null default now()
);
```

**Gotcha to keep:** don't make `ends_at` a generated column (`starts_at + interval`). `timestamptz + interval` is only STABLE, not IMMUTABLE, so Postgres rejects it in a generated column. Compute `ends_at` in the normaliser and protect it with the CHECK constraints. Mention this in ADR 0002.

**Id rules:**
- `legacy_id_map` has an entry for **every** migrated row, not only merged duplicates. It is the one way an old (Firestore) id becomes a uuid, both for FK resolution in the normalisers and for API lookups. A merged student has several entries pointing at the same uuid.
- Going from a uuid back to an old id uses the table's own `legacy_id` column. For a merged student, that is the surviving id: the oldest `createdAt`, e.g. `st_dup_rossi_a`.
- Bookings created through the API have no Firestore document. They get `legacy_id = 'api_' || <uuid>` and a `legacy_id_map` entry, so they are looked up like any other booking. The id is also a valid Firestore document id if bookings are ever copied back (reverse sync).

---

## 5. Normalisation (`src/normalize/`)

- Every normaliser is a **pure function**: `(raw, ctx) => NormalizeResult`. `ctx` holds lookups (the id maps) and the run timezone (`Europe/Rome`).
- Readers hand the normalisers a `RawDoc` (`{ id, updateTime, data }`). A Firestore `Timestamp`, or a `$timestamp` in the JSON export, arrives as a `Date`. Strings and numbers arrive exactly as stored.
- A booking's checks run in a fixed order, so each bad record gets one predictable reason: student → instructor → pickup point (warning only) → `startAt` → `durationMin` → `status` → `price`.
- Decided in Phase 3:
  - `created_at` keeps the source's `createdAt` when it has one. Otherwise, and for collections without that field, it is the doc's `updateTime`. Rows stay deterministic and comparable; they never take the migration's own time.
  - `deleted: true` becomes `deleted_at = updateTime`. The source doesn't say when the doc was deleted, and its last update is the best evidence.
  - An ISO string **with** an offset is unambiguous, so it imports without a warning, as §3.2 expects for `bk_date_iso`. Wall-clock strings (Italian or ISO without an offset) warn `DATE_PARSED_FROM_STRING`.
  - `history` statuses go through the same status map. An unmappable one is kept lower-cased, because `booking_events.status` has no CHECK. A status repeated at the same moment becomes one event.
  - `DENORM_DRIFT` compares `cityName` against the instructor's city.
- Parse with a permissive zod "raw" schema, map to the canonical shape, then validate with a strict zod schema.
- Collect **warnings** (the row still imports) and return **rejects** (the row is skipped) with the codes from §3.2.
- Dates: accept a Firestore `Timestamp`, an ISO string, the Italian `dd/MM/yyyy HH:mm` (as Europe/Rome), and epoch millis. Reject times that fall in a DST gap: Luxon `isValid` plus a round-trip check. Luxon doesn't mark gap times invalid; it shifts them forward, so the round-trip is the real check. A local time that happens twice (the autumn change, e.g. `25/10/2026 02:30`) resolves to the **first occurrence** (summer time) with warning `DATE_AMBIGUOUS`. Pick the offset explicitly instead of relying on Luxon's default.
- Status map: lowercase, trim, then `cancelled|canceled → cancelled`, `noshow|no-show|no_show → no_show`, and so on. Anything unknown is a reject.
- Phone: `libphonenumber-js` with default country `IT`, output E.164. If it can't be parsed, store `null` with a warning.
- Money: number euros → cents (`Math.round(x*100)`); `"45,50"` / `"45.50"` → cents; negative or unreadable → reject `INVALID_PRICE`; missing → `null` with warning `PRICE_MISSING`.
- Email: trim plus lowercase for matching. Store the trimmed original casing.
- Denormalised names (`DENORM_DRIFT`): compare after trimming, collapsing repeated spaces and ignoring case. Check `studentName` against `firstName + " " + lastName` of the student (the merged student, for duplicates), `instructorName` against the instructor's `fullName`, and `cityName` against the city's `name`. The copied names are never stored.
- Students dedupe: group by normalised email. The oldest `createdAt` is canonical (tie-break by doc id). Fill null fields from the duplicates. Write all legacy ids to `legacy_id_map`. Doing this in memory is fine at demo size. **Production note:** use a staging table with `row_number() over (partition by lower(trim(email)) order by created_at, legacy_id)`.
  - Only non-deleted students merge. Deleted students are imported as their own rows, with `deleted_at` set.
  - The merged row's `legacy_updated_at` is the newest `updateTime` in the group, so an edit to any duplicate counts as a change.
  - Known limit: if an email later changes so that a merged pair no longer matches, they are not split again. The decisions doc records this.

---

## 6. Backfill (`pnpm backfill`)

CLI flags: `--source=emulator|firestore|json` (default `emulator`), `--batch-size=500`, `--dry-run`, `--resume`, `--only=<collection>`.

Algorithm:

1. Create a `migration_runs` row. With `--resume`, continue the latest unfinished run from `migration_checkpoints`.
2. Process collections in FK order: `cities → pickupPoints → instructors → students → bookings` (then `booking_events` per booking).
3. Read with **cursor pagination**: `orderBy(FieldPath.documentId()).startAfter(lastId).limit(batchSize)`. After each committed batch, upsert the checkpoint.
   - Students are the exception, because a duplicate pair can span two batches. Read the whole collection (still paged) and merge duplicates **before** writing anything, then write in batches with checkpoints. A resume re-reads all students; rows already written come back unchanged.
4. For each batch, normalise every doc. Insert rejects and warnings. Write the valid rows in **one transaction per batch**.
5. **Idempotent upsert:**
   ```sql
   insert into bookings (...) values (...)
   on conflict (legacy_id) do update set ... , legacy_updated_at = excluded.legacy_updated_at
   where bookings.legacy_updated_at is null
      or bookings.legacy_updated_at < excluded.legacy_updated_at
   returning (xmax = 0) as inserted;
   ```
   - This is the **same newer-wins rule live sync uses** (§8). Live sync starts before the backfill. With "is distinct from", a backfill batch read just before a live edit could overwrite the newer row the listener had already saved.
   - Trade-off: re-running after a normaliser fix doesn't touch docs whose `updateTime` didn't change. Add a `--force` flag if that is ever needed.
   - No row returned means **unchanged** (the stored version is the same or newer).
   - `inserted = true` means **inserted**; otherwise it was **updated**.
   - Count all three.
6. **Constraint violations per row without killing the batch:** wrap each booking insert in a `SAVEPOINT`.
   - On SQLSTATE `23P01` (exclusion_violation), roll back to the savepoint. Look up the conflicting booking's legacy id and record `OVERLAP_INSTRUCTOR` or `OVERLAP_STUDENT` (from the constraint name).
   - On `23503` (FK), record `ORPHAN_*`.
   - **Production note:** at scale, COPY into a staging table and detect overlaps with one set-based query before inserting.
   - *Built in Phase 4 as split-and-retry* (`src/migrate/write-rows.ts`):
     - Each batch goes out as **one** multi-row upsert, with column arrays passed through `unnest`, under a savepoint.
     - If a row breaks a constraint, the writer rolls back to the savepoint and retries the first half, then the second half, down to the single bad row.
     - The halves go in order, so the outcome is identical to one savepoint per row, "first in wins" included.
     - A clean batch costs one round trip instead of about 3 per row, which matters with the database on another machine. The full backfill takes ~3 s over Wi-Fi.
     - Other entities use the same writer: a unique or CHECK violation becomes `INVALID_RECORD`, naming the constraint.
7. History → `booking_events` with `on conflict do nothing`.
8. `--dry-run` first saves the `migration_runs` row (with `dry_run = true`) in its own transaction. It then does everything else inside one transaction and rolls back at the end. The report is still produced, and it names a run that exists.
9. At the end, write `migration_runs.stats` and print a console table per entity: read, inserted, updated, unchanged, rejected (by code), warnings (by code). Also write `reports/run-<id>.md` and `.json`.

Acceptance:
- Running the backfill **twice** gives `inserted=0, updated=0` on the second run, with every row unchanged.
- Killing the process mid-run and re-running with `--resume` finishes with the same final state as one uninterrupted run.
- Every known-bad fixture in §3.2 ends in exactly the expected outcome.

---

## 7. Reconciliation (`pnpm reconcile`)

1. **Counts per entity:** `firestore_docs = pg_rows + rejected + merged_duplicates`. For students, merged duplicates live in `legacy_id_map` and aren't separate rows. `pg_rows` leaves out API rows and rows deleted in the source (see the rules below).
2. **Per-record checksums:**
   - Normalise each Firestore doc with the *same* normaliser, build a canonical JSON (sorted keys, UTC ISO timestamps, cents, FKs expressed as **legacy ids**), then `sha256`.
   - Build the same canonical JSON from each Postgres row, mapping uuids back to legacy ids through each table's own `legacy_id` column.
   - FKs to a merged student are expressed as the **surviving id** on both sides. `bk_dup_student_ref` points at `st_dup_rossi_b` in Firestore, but both sides compare it as `st_dup_rossi_a`. Otherwise it would mismatch forever, and reconciliation could never exit 0.
   - Compare by legacy id and report `missing_in_pg`, `extra_in_pg` and `mismatched`, with the field names that differ. Never print PII values.
   - Rules for records present on only one side:
     - Not in Postgres, with at least one `migration_rejects` row from any run (backfill or sync): an **expected gap**. It is counted, not a failure.
     - Not in Postgres and never rejected: `missing_in_pg`. This is a failure.
     - In Postgres, soft-deleted, with no Firestore doc (hard-deleted in the source and picked up by sync): reported as **deleted in source**, not a failure.
     - Rows with `source = 'api'` exist only in Postgres and are left out of reconciliation.
3. **Aggregate checks:** the number of active bookings and the sum of `price_cents` per month, on both sides.
4. **Output:** a console summary plus `reports/reconcile-<id>.md`. Exit code `0` if clean (expected gaps, rows deleted in source and API rows don't count against it), `1` otherwise. This is the cutover gate.

Acceptance: a clean backfill reconciles with exit 0. Manually changing one Postgres row (`update bookings set price_cents = price_cents + 1 where legacy_id = '...'`) makes it exit 1 and name that record and field.

---

## 8. Live sync (`pnpm sync`)

- `syncDocument(collection, snapshot)` reuses the normaliser and the upsert. It is shared by the backfill and the listener.
- **Newer wins:** the same upsert `where` as the backfill (§6): `bookings.legacy_updated_at is null or bookings.legacy_updated_at < excluded.legacy_updated_at`. This makes duplicate and out-of-order events harmless.
- **Student events redo the merge.** The listener keeps every student doc in memory (it receives them all anyway). When a student changes, it reruns the dedupe for that normalised email and upserts the merged row. That way an edit to `st_dup_rossi_b` updates the merged student instead of overwriting it with b's fields. **Production note:** keep the email → legacy ids grouping in a Postgres table instead of memory.
- A deleted doc gets `deleted_at = now()`; nothing is ever hard-deleted.
- Locally, use `onSnapshot` listeners on the emulator to simulate triggers. Demo: edit a booking in the Emulator UI (localhost:4000) and it shows up in Postgres within a second.
- Start the listener **before** the backfill so no change falls in a gap. Newer-wins makes the overlap safe.
- **Production note (write in the docs, don't build):** Cloud Functions v2 `onDocumentWritten` → Pub/Sub (or Cloud Tasks) → Cloud Run worker calling `syncDocument`. Delivery is at-least-once, so the handler is idempotent. Failed messages go to a dead-letter topic, and reconciliation runs nightly.

Acceptance (integration test): applying an event with an older `updateTime` after a newer one leaves the newer data in place.

---

## 9. Fastify API (`pnpm dev`)

- Routes:
  - `GET /health`
  - `GET /v1/bookings/:legacyId`
  - `GET /v1/instructors/:legacyId/bookings?from&to`
  - `POST /v1/bookings`
- During the transition, the API speaks **legacy (Firestore) ids**, because that's what the app knows today. Postgres looks them up via `legacy_id` and `legacy_id_map`.
- Repository interface `BookingsRepo` has three implementations:
  - `PostgresBookingsRepo`
  - `FirestoreBookingsRepo`, which reads the emulator and normalises with the same code
  - `ShadowBookingsRepo`, which reads both in parallel and **returns Firestore**. It compares the canonical forms and logs `shadow_diff` with the legacy id and field names only. It also keeps an in-memory diff counter exposed on `GET /debug/shadow-stats`.
- Read source per route, from env: `BOOKINGS_READ_SOURCE=firestore|postgres|shadow`. Optionally the `x-read-source` header can override it in non-production, for the demo.
- `POST /v1/bookings` writes to **Postgres** (the future write path) with `source='api'`. It generates `legacy_id = 'api_<uuid>'`, adds the `legacy_id_map` entry, and returns that id (see the id rules in §4).
  - Error mapping in `errors.ts`: `23P01` → `409 { code: "BOOKING_OVERLAP" }`, `23503` → `422 { code: "UNKNOWN_REFERENCE" }`, `23514` → `422 { code: "CONSTRAINT_VIOLATION" }`.
- Every route has zod schemas.
- Logging uses pino, with `redact` (`src/logger.ts`) for contact details, tax codes, names and free-text notes, in camelCase (source docs) and snake_case (Postgres rows), at the top level and one level down (`*.email`). Also redacted: `req.headers.authorization`, and `err.detail`, where pg puts row values.
- Tests use `app.inject`.

Acceptance: a POST that overlaps an existing confirmed booking returns 409. Shadow mode logs a diff for a record changed only in Postgres.

---

## 10. Docs

### README.md
- What this is (2 lines), the problem, and the approach
- Quickstart: `pnpm i && pnpm db:up && pnpm db:migrate`, start the emulator, `pnpm seed`, `pnpm backfill`, `pnpm reconcile`
- **Demo script**: commands in order, each with the output you should see
- A Mermaid architecture diagram:
  ```mermaid
  flowchart LR
    App[FlutterFlow app] -->|reads/writes today| FS[(Firestore)]
    FS -->|backfill| BF[Backfill]
    FS -->|onDocumentWritten| SYNC[Sync worker]
    BF --> PG[(Postgres)]
    SYNC --> PG
    API[Fastify API] -->|flag: firestore / postgres / shadow| FS
    API --> PG
    REC[Reconciliation] --> FS
    REC --> PG
  ```
- Design decisions in bullets, each linking to its ADR

### docs/migration-strategy.md
Phases, each with entry and exit criteria and a rollback:

0. **Prepare:** schema, backfill and reconciliation in CI. Postgres in an EU region (e.g. `europe-west8` Milan).
1. **Mirror:** Firestore stays the source of truth. Postgres is filled by the backfill plus live sync, and reconciliation runs nightly. *Rollback: nothing to roll back.*
2. **Shadow reads:** the API reads both and serves Firestore. Fix diffs until it's clean for N days.
3. **Read cutover per screen:** flip the flag screen by screen in the FlutterFlow app via API calls. *Rollback: flip the flag back.*
4. **Write cutover:** writes go through the API into Postgres. A **reverse sync** (transactional outbox → Firestore) keeps **old app versions** that still read Firestore working.
5. **Decommission:** force an app update with a minimum supported version (Firebase Remote Config), stop the reverse sync, freeze Firestore read-only, then archive it.

Also cover:
- **FlutterFlow specifics:** screens bound directly to Firestore queries have to be rewired to API calls. Old app versions in the stores can't be rewired, hence the reverse sync plus the forced update.
- **Team split for 4–5 devs** on a Kanban board with WIP limits:
  - 1 dev: schema and backfill
  - 1 dev: sync pipeline and reverse sync
  - 1–2 devs: API and per-screen cutover, paired with whoever owns the FlutterFlow app
  - 1 dev: reconciliation, observability and QA
  - Tech lead: ADRs, reviews, cutover runbook and go/no-go
- **Risks** and mitigations, and a rough timeline
- **GDPR:**
  - EU data residency
  - Data minimisation: Postgres doesn't copy the denormalised names
  - PII redacted in logs; `migration_rejects.payload` access-restricted and purged after cutover
  - Updating the processing records
  - Erasure handled on both stores during the dual-run

### docs/data-quality-decisions.md
A table: issue → rule → outcome (fix / warn / reject) → owner → status. Cover every row of §3.2 and §3.3, plus "rescheduled status: needs product decision". List the known limits too: merged students aren't split again when an email changes, and ambiguous autumn times take the first occurrence.

### ADRs (short, one page each)
- 0001: why Postgres (relational integrity, constraints, reporting, cost predictability)
- 0002: exclusion constraint vs app-level checks (race conditions; the `ends_at` gotcha)
- 0003: idempotent upserts with `legacy_updated_at`, newer wins

---

## 11. Tests (Vitest)

**Unit** (table-driven, no I/O):
- every normaliser, including all of §3.2 and §3.3
- the DST gap and the ambiguous autumn time
- the four date formats of the same instant give one moment
- the status map
- phone formats
- the money parser
- student dedupe (deleted students don't merge)
- denormalised-name comparison
- canonical JSON stability (key order, timestamps)

**Integration** (the Postgres at `TEST_DATABASE_URL` plus the JSON source):
- schema migrates from zero
- exclusion constraint:
  - overlap → `23P01`
  - adjacent is OK
  - cancelled overlap is OK
  - deleted overlap is OK
- the backfill end-to-end: every known-bad fixture lands in its expected outcome
- **idempotency**: a second run is all unchanged
- **resume**: a simulated crash after batch 2, then resume, gives an identical final state
- `--dry-run` leaves only its `migration_runs` row behind
- reconciliation is clean after the backfill, then detects a mutation
- reconciliation doesn't fail on merged-student references, API rows or rows deleted in the source
- sync: newer wins, a stale event is ignored, a delete soft-deletes, and an edit to a merged duplicate updates the merged student
- API:
  - 409 on overlap
  - 422 on unknown student
  - shadow diff logged

CI (GitHub Actions): `pnpm typecheck && pnpm lint && pnpm db:migrate && pnpm test` against a `postgres:16` service container. The JSON source means no emulator is needed in CI.

---

## 12. Phases and checklist

Stop at the end of each phase. Show what changed, how to verify it, and the test output, then wait for "go".

- [x] **Phase 0 — Scaffold**
  - pnpm, TS strict, biome, vitest, compose Postgres, `.env.example`, zod config, pino logger, migration runner, CI workflow
  - `.gitignore` covers `.env`, `reports/`, `*service-account*.json`
  - *Done when:* `pnpm typecheck`, `pnpm lint` and `pnpm test` (a placeholder test) pass, and `pnpm db:up && pnpm db:migrate` works.
- [x] **Phase 1 — Seed messy data**
  - `pnpm seed --target=emulator|json|firestore`, deterministic, with every fixture in §3.2
  - Firestore writes in batches of ≤ 500
  - `--target=json` writes `test/fixtures/export.json`. `--target=emulator` clears the emulator first. `--target=firestore` refuses unless real credentials are set and the collections are empty.
  - *Done when:* the emulator UI shows the collections, and the JSON export has the fixture ids.
- [x] **Phase 2 — Schema**
  - migrations 001–004 exactly as in §4, plus `updated_at` triggers
  - *Done when:* integration tests for the constraints pass.
- [x] **Phase 3 — Normalisers**
  - *Done when:* unit tests cover every §3.2 row.
- [x] **Phase 4 — Backfill**
  - per §6, with report output
  - *Done when:* the §6 acceptance tests pass.
- [ ] **Phase 5 — Reconciliation**
  - per §7
  - *Done when:* the §7 acceptance tests pass.
- [ ] **Phase 6 — Live sync**
  - per §8
  - *Done when:* the §8 acceptance tests pass, and a manual emulator edit appears in Postgres.
- [ ] **Phase 7 — API**
  - per §9
  - *Done when:* the §9 acceptance tests pass.
- [ ] **Phase 8 — Docs**
  - README, strategy, decisions, ADRs, per §10
  - *Done when:* a reviewer can follow the README demo script on a fresh clone.
- [ ] **Phase 9 — Final verification**
  - `scripts/demo.sh` runs the whole flow from scratch: db up, migrate, emulator, seed, backfill, backfill again (idempotency), reconcile, start the API, curl a 409. It finishes with a summary.
  - Fix anything that breaks.

**Stretch (only if everything above is done):**
- transactional outbox table plus a reverse-sync worker (Postgres → Firestore) for old app versions
- the staging-table COPY path for the backfill
- a Dockerfile for Cloud Run
- OpenTelemetry traces around backfill batches

---

## 13. Interview demo (5 minutes)

1. Run `pnpm seed`. Show the messy data in the Emulator UI: a text date, the overlap pair, the duplicate Rossi.
2. Run `pnpm backfill`. Walk through the report table: inserted, warnings by code, rejects by code.
3. Run `pnpm backfill` again. Everything is unchanged: it's idempotent.
4. Open the rejects: `OVERLAP_INSTRUCTOR` names the conflicting booking. The database makes double-booking impossible, even under race conditions.
5. Run `pnpm reconcile` and get exit 0. Mutate one row, run it again, and get exit 1 naming the record and field.
6. Run the API with `x-read-source: shadow` and show the diff log. Then POST an overlapping booking and get a 409.
7. Close with `docs/migration-strategy.md`: the phases, old FlutterFlow versions, the team split and rollback at each step.
