import type { CollectionName } from "../source/collections.js";
import type { RawDoc } from "../source/types.js";
import { normalizeCity } from "./cities.js";
import { type NormalizeContext, ROME_TIME_ZONE, type StudentRef } from "./context.js";
import { normalizeInstructor } from "./instructors.js";
import { normalizePickupPoint } from "./pickup-points.js";
import { mergeDuplicateStudents, normalizeStudent, type StudentMerge } from "./students.js";

/**
 * A context built from source documents alone, with no Postgres. Ids are the canonical legacy
 * ids (there are no uuids yet). Used by tests and by read paths that only see the source.
 */
export function contextFromSource(docs: Readonly<Record<CollectionName, readonly RawDoc[]>>): {
  context: NormalizeContext;
  merge: StudentMerge;
} {
  const context: NormalizeContext = {
    timeZone: ROME_TIME_ZONE,
    cities: () => undefined,
    pickupPoints: () => undefined,
    instructors: () => undefined,
    students: () => undefined,
  };

  const cities = new Map(
    docs.cities.flatMap((doc) => {
      const result = normalizeCity(doc);
      return result.ok
        ? [[doc.id, { id: doc.id, legacyId: doc.id, name: result.value.name }] as const]
        : [];
    }),
  );
  context.cities = (legacyId) => cities.get(legacyId);

  const pickupPoints = new Map(
    docs.pickupPoints.flatMap((doc) => {
      const result = normalizePickupPoint(doc, context);
      return result.ok
        ? [
            [
              doc.id,
              { id: doc.id, legacyId: doc.id, cityLegacyId: result.value.cityLegacyId },
            ] as const,
          ]
        : [];
    }),
  );
  context.pickupPoints = (legacyId) => pickupPoints.get(legacyId);

  const instructors = new Map(
    docs.instructors.flatMap((doc) => {
      const result = normalizeInstructor(doc, context);
      if (!result.ok) return [];
      const cityName = cities.get(result.value.cityLegacyId)?.name ?? "";
      return [
        [
          doc.id,
          { id: doc.id, legacyId: doc.id, fullName: result.value.fullName, cityName },
        ] as const,
      ];
    }),
  );
  context.instructors = (legacyId) => instructors.get(legacyId);

  const candidates = docs.students.flatMap((doc) => {
    const result = normalizeStudent(doc, context);
    return result.ok ? [result.value] : [];
  });
  const merge = mergeDuplicateStudents(candidates);
  const students = new Map<string, StudentRef>();
  for (const student of merge.students) {
    const ref = {
      id: student.legacyId,
      legacyId: student.legacyId,
      firstName: student.firstName,
      lastName: student.lastName,
    };
    for (const legacyId of student.legacyIds) students.set(legacyId, ref);
  }
  context.students = (legacyId) => students.get(legacyId);

  return { context, merge };
}
