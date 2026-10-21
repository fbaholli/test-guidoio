import { DateTime } from "luxon";
import { SeedTimestamp } from "./types.js";

export const ROME = "Europe/Rome";

/** First day of the 8-week booking window, a Monday. Fixed, so the seed never depends on today. */
export const WINDOW_START = romeTime("2026-09-07", "00:00");
export const WINDOW_DAYS = 8 * 7;

/** When the dataset is "taken": lessons that ended before it are in the past. */
export const SNAPSHOT = romeTime("2026-10-19", "07:00");

/** A wall-clock time in Rome, e.g. romeTime("2026-09-15", "10:00"). */
export function romeTime(date: string, time: string): DateTime {
  const value = DateTime.fromISO(`${date}T${time}`, { zone: ROME });
  if (!value.isValid) throw new Error(`Invalid Rome time ${date} ${time}`);
  return value;
}

export function utcIso(value: DateTime): string {
  const iso = value.toUTC().toISO();
  if (iso === null) throw new Error("Cannot format an invalid DateTime");
  return iso;
}

export function seedTimestamp(value: DateTime): SeedTimestamp {
  return new SeedTimestamp(utcIso(value));
}
