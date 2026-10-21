import type { ColumnType, Generated } from "kysely";

// Hand-written to match db/migrations. pg returns timestamptz as Date, numeric and bigint as
// strings (to avoid losing precision), text[] as string[] and jsonb as parsed JSON.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Numeric = ColumnType<string | null, number | string | null, number | string | null>;
type BigIntId = ColumnType<string, never, never>;

export type BookingStatus = "booked" | "confirmed" | "completed" | "cancelled" | "no_show";
export type LicenseCategory = "AM" | "A1" | "A2" | "A" | "B";

type LegacyColumns = {
  id: Generated<string>;
  legacy_id: string;
  legacy_updated_at: NullableTimestamp;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
};

export type CitiesTable = LegacyColumns & { name: string; region: string | null };

export type PickupPointsTable = LegacyColumns & {
  city_id: string;
  name: string;
  address: string | null;
  lat: Numeric;
  lng: Numeric;
};

export type InstructorsTable = LegacyColumns & {
  city_id: string;
  full_name: string;
  email: string | null;
  phone_e164: string | null;
  license_categories: ColumnType<string[], string[] | undefined, string[]>;
  active: Generated<boolean>;
};

export type StudentsTable = LegacyColumns & {
  city_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone_e164: string | null;
  tax_code: string | null;
  license_category: LicenseCategory | null;
  deleted_at: NullableTimestamp;
};

export type LegacyIdMapTable = { entity: string; legacy_id: string; new_id: string };

export type BookingsTable = LegacyColumns & {
  student_id: string;
  instructor_id: string;
  pickup_point_id: string | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: BookingStatus;
  price_cents: number | null;
  paid: Generated<boolean>;
  notes: string | null;
  deleted_at: NullableTimestamp;
  source: Generated<"firestore" | "api">;
};

export type BookingEventsTable = {
  id: BigIntId;
  booking_id: string;
  status: string;
  occurred_at: Timestamp;
  actor: string | null;
  source: Generated<string>;
};

export type MigrationRunsTable = {
  id: Generated<string>;
  mode: "backfill" | "sync" | "reconcile";
  source: string;
  dry_run: Generated<boolean>;
  started_at: DefaultTimestamp;
  finished_at: NullableTimestamp;
  stats: ColumnType<unknown, string | undefined, string>;
};

export type MigrationCheckpointsTable = {
  run_id: string;
  collection: string;
  last_doc_id: string;
  updated_at: DefaultTimestamp;
};

export type MigrationRejectsTable = {
  id: BigIntId;
  run_id: string;
  entity: string;
  legacy_id: string;
  reason_code: string;
  reason_detail: string | null;
  payload: ColumnType<unknown, string, string>;
  created_at: DefaultTimestamp;
};

export type MigrationWarningsTable = {
  id: BigIntId;
  run_id: string;
  entity: string;
  legacy_id: string;
  code: string;
  detail: string | null;
  created_at: DefaultTimestamp;
};

export type DB = {
  cities: CitiesTable;
  pickup_points: PickupPointsTable;
  instructors: InstructorsTable;
  students: StudentsTable;
  legacy_id_map: LegacyIdMapTable;
  bookings: BookingsTable;
  booking_events: BookingEventsTable;
  migration_runs: MigrationRunsTable;
  migration_checkpoints: MigrationCheckpointsTable;
  migration_rejects: MigrationRejectsTable;
  migration_warnings: MigrationWarningsTable;
};
