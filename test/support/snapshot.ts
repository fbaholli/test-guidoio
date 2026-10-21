import type pg from "pg";

// Everything a migration writes, expressed in legacy ids instead of uuids, so two databases
// filled by different runs can be compared row for row.
const QUERIES: Record<string, string> = {
  cities:
    "select legacy_id, name, region, created_at, legacy_updated_at from cities order by legacy_id",
  pickup_points: `select p.legacy_id, c.legacy_id as city, p.name, p.address, p.lat, p.lng, p.legacy_updated_at
                  from pickup_points p join cities c on c.id = p.city_id order by p.legacy_id`,
  instructors: `select i.legacy_id, c.legacy_id as city, i.full_name, i.email, i.phone_e164, i.license_categories,
                       i.active, i.legacy_updated_at
                from instructors i join cities c on c.id = i.city_id order by i.legacy_id`,
  students: `select s.legacy_id, c.legacy_id as city, s.first_name, s.last_name, s.email, s.phone_e164, s.tax_code,
                    s.license_category, s.deleted_at, s.created_at, s.legacy_updated_at
             from students s left join cities c on c.id = s.city_id order by s.legacy_id`,
  legacy_id_map: `select m.entity, m.legacy_id,
                         coalesce(c.legacy_id, p.legacy_id, i.legacy_id, s.legacy_id, b.legacy_id) as points_to
                  from legacy_id_map m
                  left join cities c on c.id = m.new_id left join pickup_points p on p.id = m.new_id
                  left join instructors i on i.id = m.new_id left join students s on s.id = m.new_id
                  left join bookings b on b.id = m.new_id
                  order by m.entity, m.legacy_id`,
  bookings: `select b.legacy_id, s.legacy_id as student, i.legacy_id as instructor, p.legacy_id as pickup,
                    b.starts_at, b.ends_at, b.status, b.price_cents, b.paid, b.notes, b.deleted_at, b.source,
                    b.created_at, b.legacy_updated_at
             from bookings b join students s on s.id = b.student_id join instructors i on i.id = b.instructor_id
             left join pickup_points p on p.id = b.pickup_point_id order by b.legacy_id`,
  booking_events: `select b.legacy_id, e.status, e.occurred_at, e.actor, e.source
                   from booking_events e join bookings b on b.id = e.booking_id
                   order by b.legacy_id, e.occurred_at, e.status`,
  rejects: `select entity, legacy_id, reason_code, reason_detail from migration_rejects
            order by entity, legacy_id`,
  warnings: `select entity, legacy_id, code, detail from migration_warnings
             order by entity, legacy_id, code, detail`,
};

export async function snapshot(pool: pg.Pool): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    tables[name] = (await pool.query(sql)).rows;
  }
  return tables;
}
