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

create trigger bookings_set_updated_at before update on bookings
  for each row execute function set_updated_at();
