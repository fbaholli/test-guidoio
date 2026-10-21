import { type NormalizeContext, ROME_TIME_ZONE } from "../../src/normalize/context.js";
import type { NormalizeResult } from "../../src/normalize/result.js";
import type { RawDoc } from "../../src/source/types.js";

export const UPDATE_TIME = new Date("2026-10-19T05:00:00.000Z");

export function raw(id: string, data: Record<string, unknown>, updateTime = UPDATE_TIME): RawDoc {
  return { id, updateTime, data };
}

/** A tiny world: one city, one pickup point, one instructor, and a student merged from two docs. */
export function testContext(): NormalizeContext {
  const rossi = { id: "uuid-st_a", legacyId: "st_a", firstName: "Mario", lastName: "Rossi" };
  const students = new Map([
    ["st_a", rossi],
    ["st_b", rossi],
  ]);
  return {
    timeZone: ROME_TIME_ZONE,
    cities: (id) =>
      id === "ct_milano" ? { id: "uuid-ct_milano", legacyId: id, name: "Milano" } : undefined,
    pickupPoints: (id) =>
      id === "pp_duomo"
        ? { id: "uuid-pp_duomo", legacyId: id, cityLegacyId: "ct_milano" }
        : undefined,
    instructors: (id) =>
      id === "in_1"
        ? { id: "uuid-in_1", legacyId: id, fullName: "Sara Ricci", cityName: "Milano" }
        : undefined,
    students: (id) => students.get(id),
  };
}

/** A result reduced to what tests compare: the outcome code and the warning codes. */
export function outcome<T>(result: NormalizeResult<T>) {
  return result.ok
    ? { ok: true, warnings: result.warnings.map((w) => w.code) }
    : { ok: false, reason: result.reason };
}

export function okValue<T>(result: NormalizeResult<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${result.reason}: ${result.detail}`);
  return result.value;
}
