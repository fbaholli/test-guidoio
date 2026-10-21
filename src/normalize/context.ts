// What the normalisers may look up. The caller builds these from Postgres (backfill, sync) or
// from source data (tests, the Firestore read path); the normalisers themselves do no I/O.

export type CityRef = { id: string; legacyId: string; name: string };
export type PickupPointRef = { id: string; legacyId: string; cityLegacyId: string };
export type InstructorRef = { id: string; legacyId: string; fullName: string; cityName: string };
/** For a merged duplicate, `legacyId` is the surviving id, whichever id was looked up. */
export type StudentRef = { id: string; legacyId: string; firstName: string; lastName: string };

export type Lookup<T> = (legacyId: string) => T | undefined;

export type NormalizeContext = {
  /** Wall-clock strings without an offset are read in this zone. */
  timeZone: string;
  cities: Lookup<CityRef>;
  pickupPoints: Lookup<PickupPointRef>;
  instructors: Lookup<InstructorRef>;
  students: Lookup<StudentRef>;
};

export const ROME_TIME_ZONE = "Europe/Rome";
