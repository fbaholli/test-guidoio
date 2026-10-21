/** Firestore collections in foreign-key order: each one only references the ones before it. */
export const COLLECTIONS = [
  "cities",
  "pickupPoints",
  "instructors",
  "students",
  "bookings",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];
