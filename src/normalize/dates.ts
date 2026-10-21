import { DateTime } from "luxon";
import { type NormalizeResult, ok, reject, type Warning, warning } from "./result.js";

// Instants are accepted as a Firestore Timestamp (a Date by the time it gets here), an ISO
// string with an offset, epoch millis, or a wall-clock string read in the run's time zone:
// Italian "dd/MM/yyyy HH:mm" or ISO without an offset.

const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ITALIAN_LOCAL = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function parseInstant(
  value: unknown,
  field: string,
  timeZone: string,
): NormalizeResult<Date> {
  if (value instanceof Date) {
    return inRange(value.getTime())
      ? ok(value)
      : reject("INVALID_DATE", `${field} is out of range`);
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && inRange(value)
      ? ok(new Date(value), [warning("DATE_PARSED_FROM_NUMBER", field)])
      : reject("INVALID_DATE", `${field} is not a usable epoch value`);
  }
  if (typeof value === "string") return parseText(value.trim(), field, timeZone);
  return reject("INVALID_DATE", `${field} is not a date`);
}

function parseText(text: string, field: string, timeZone: string): NormalizeResult<Date> {
  if (ISO_WITH_OFFSET.test(text)) {
    const parsed = DateTime.fromISO(text, { setZone: true });
    return parsed.isValid && inRange(parsed.toMillis())
      ? ok(parsed.toJSDate())
      : reject("INVALID_DATE", `${field} is not a valid ISO date`);
  }

  const iso = ISO_LOCAL.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso;
    return fromWallClock(toWallClock(year, month, day, hour, minute, second), field, timeZone);
  }

  const italian = ITALIAN_LOCAL.exec(text);
  if (italian) {
    const [, day, month, year, hour, minute, second] = italian;
    return fromWallClock(toWallClock(year, month, day, hour, minute, second), field, timeZone);
  }

  return reject("INVALID_DATE", `${field} is not in a recognised date format`);
}

/**
 * Turns a local wall-clock time into an instant. Luxon quietly moves a time that doesn't exist
 * (the spring gap) forward and picks one of two times that happen twice (the autumn change),
 * so both cases are checked here explicitly.
 */
function fromWallClock(wall: WallClock, field: string, timeZone: string): NormalizeResult<Date> {
  const candidate = DateTime.fromObject(wall, { zone: timeZone });
  if (!candidate.isValid || !inRange(candidate.toMillis())) {
    return reject("INVALID_DATE", `${field} is not a real calendar date`);
  }
  if (!showsWallClock(candidate, wall)) {
    return reject("DST_GAP", `${field} falls in the daylight-saving gap in ${timeZone}`);
  }

  const occurrences = [candidate.minus({ hours: 1 }), candidate, candidate.plus({ hours: 1 })]
    .filter((instant) => showsWallClock(instant, wall))
    .sort((a, b) => a.toMillis() - b.toMillis());
  const first = occurrences[0] ?? candidate;
  const warnings: Warning[] = [warning("DATE_PARSED_FROM_STRING", field)];
  if (occurrences.length > 1) {
    warnings.push(warning("DATE_AMBIGUOUS", `${field} happens twice; took the first occurrence`));
  }
  return ok(first.toJSDate(), warnings);
}

function showsWallClock(instant: DateTime, wall: WallClock): boolean {
  return (
    instant.year === wall.year &&
    instant.month === wall.month &&
    instant.day === wall.day &&
    instant.hour === wall.hour &&
    instant.minute === wall.minute &&
    instant.second === wall.second
  );
}

function toWallClock(...parts: Array<string | undefined>): WallClock {
  const [year, month, day, hour, minute, second] = parts.map((part) => Number(part ?? 0));
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
  };
}

function inRange(millis: number): boolean {
  return Number.isFinite(millis) && millis >= EARLIEST && millis < LATEST;
}
