import type pg from "pg";
import { z } from "zod";
import type {
  CityRef,
  InstructorRef,
  NormalizeContext,
  PickupPointRef,
  StudentRef,
} from "../normalize/context.js";

// legacy_id_map holds every migrated row: the one way an old Firestore id becomes a uuid.
// A merged student has several entries pointing at the same uuid.

export type IdMapEntry = { legacyId: string; newId: string };

export async function saveIdMap(
  client: pg.ClientBase,
  entity: string,
  entries: readonly IdMapEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await client.query(
    `insert into legacy_id_map (entity, legacy_id, new_id)
     select $1, l, i from unnest($2::text[], $3::uuid[]) as t(l, i)
     on conflict (entity, legacy_id) do update set new_id = excluded.new_id
     where legacy_id_map.new_id is distinct from excluded.new_id`,
    [entity, entries.map((e) => e.legacyId), entries.map((e) => e.newId)],
  );
}

/** The uuids of rows already in a table, by legacy id. */
export async function idsByLegacyId(
  client: pg.ClientBase,
  table: "cities" | "pickup_points" | "instructors" | "students" | "bookings",
  legacyIds: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await client.query(
    `select legacy_id, id from ${table} where legacy_id = any($1::text[])`,
    [legacyIds],
  );
  const parsed = z.array(z.object({ legacy_id: z.string(), id: z.string() })).parse(rows);
  return new Map(parsed.map((row) => [row.legacy_id, row.id]));
}

const cityRows = z.array(z.object({ legacy_id: z.string(), id: z.string(), name: z.string() }));
const pickupRows = z.array(
  z.object({ legacy_id: z.string(), id: z.string(), city_legacy_id: z.string() }),
);
const instructorRows = z.array(
  z.object({ legacy_id: z.string(), id: z.string(), full_name: z.string(), city_name: z.string() }),
);
const studentRows = z.array(
  z.object({
    legacy_id: z.string(),
    id: z.string(),
    canonical_legacy_id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
  }),
);

/** Lookups for the normalisers, read from what Postgres holds right now. */
export async function loadContext(
  client: pg.ClientBase,
  timeZone: string,
): Promise<NormalizeContext> {
  const cities = cityRows.parse(
    (await client.query("select legacy_id, id, name from cities")).rows,
  );
  const pickups = pickupRows.parse(
    (
      await client.query(
        `select p.legacy_id, p.id, c.legacy_id as city_legacy_id
         from pickup_points p join cities c on c.id = p.city_id`,
      )
    ).rows,
  );
  const instructors = instructorRows.parse(
    (
      await client.query(
        `select i.legacy_id, i.id, i.full_name, c.name as city_name
         from instructors i join cities c on c.id = i.city_id`,
      )
    ).rows,
  );
  const students = studentRows.parse(
    (
      await client.query(
        `select m.legacy_id, s.id, s.legacy_id as canonical_legacy_id, s.first_name, s.last_name
         from legacy_id_map m join students s on s.id = m.new_id
         where m.entity = 'student'`,
      )
    ).rows,
  );

  const cityMap = new Map<string, CityRef>(
    cities.map((r) => [r.legacy_id, { id: r.id, legacyId: r.legacy_id, name: r.name }]),
  );
  const pickupMap = new Map<string, PickupPointRef>(
    pickups.map((r) => [
      r.legacy_id,
      { id: r.id, legacyId: r.legacy_id, cityLegacyId: r.city_legacy_id },
    ]),
  );
  const instructorMap = new Map<string, InstructorRef>(
    instructors.map((r) => [
      r.legacy_id,
      { id: r.id, legacyId: r.legacy_id, fullName: r.full_name, cityName: r.city_name },
    ]),
  );
  const studentMap = new Map<string, StudentRef>(
    students.map((r) => [
      r.legacy_id,
      { id: r.id, legacyId: r.canonical_legacy_id, firstName: r.first_name, lastName: r.last_name },
    ]),
  );

  return {
    timeZone,
    cities: (legacyId) => cityMap.get(legacyId),
    pickupPoints: (legacyId) => pickupMap.get(legacyId),
    instructors: (legacyId) => instructorMap.get(legacyId),
    students: (legacyId) => studentMap.get(legacyId),
  };
}
