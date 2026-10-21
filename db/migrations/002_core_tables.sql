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

-- Keeps updated_at honest on every UPDATE. An upsert whose WHERE skips the row (an unchanged
-- source doc) performs no update, so updated_at only moves when data really changed.
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cities_set_updated_at before update on cities
  for each row execute function set_updated_at();
create trigger pickup_points_set_updated_at before update on pickup_points
  for each row execute function set_updated_at();
create trigger instructors_set_updated_at before update on instructors
  for each row execute function set_updated_at();
create trigger students_set_updated_at before update on students
  for each row execute function set_updated_at();
