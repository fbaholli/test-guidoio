import { DateTime } from "luxon";
import { type SeedDoc, SeedTimestamp } from "../../src/seed/types.js";

// Typed accessors for seed docs in tests: a wrong type fails loudly instead of comparing as undefined.

export function docById(docs: readonly SeedDoc[], id: string): SeedDoc {
  const doc = docs.find((candidate) => candidate.id === id);
  if (!doc) throw new Error(`No doc ${id}`);
  return doc;
}

export function text(doc: SeedDoc, field: string): string {
  const value = doc.fields[field];
  if (typeof value !== "string") throw new Error(`${doc.id}.${field} is not a string`);
  return value;
}

export function num(doc: SeedDoc, field: string): number {
  const value = doc.fields[field];
  if (typeof value !== "number") throw new Error(`${doc.id}.${field} is not a number`);
  return value;
}

export function instant(doc: SeedDoc, field: string): DateTime {
  const value = doc.fields[field];
  if (!(value instanceof SeedTimestamp)) throw new Error(`${doc.id}.${field} is not a timestamp`);
  return DateTime.fromISO(value.iso, { zone: "utc" });
}

/** A lesson's [start, end) in epoch millis; a missing duration means the 60-minute default. */
export function lessonRange(doc: SeedDoc): [number, number] {
  const start = instant(doc, "startAt").toMillis();
  const duration = doc.fields.durationMin === undefined ? 60 : num(doc, "durationMin");
  return [start, start + duration * 60_000];
}

export function overlaps([startA, endA]: [number, number], [startB, endB]: [number, number]) {
  return startA < endB && startB < endA;
}

export function normalisedEmail(doc: SeedDoc): string {
  return text(doc, "email").trim().toLowerCase();
}
