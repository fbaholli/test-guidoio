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
