import type { BookingStatus } from "../db/types.js";
import { type NormalizeResult, ok, reject, warning } from "./result.js";

const STATUS_BY_SPELLING: ReadonlyMap<string, BookingStatus> = new Map([
  ["booked", "booked"],
  ["confirmed", "confirmed"],
  ["completed", "completed"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
  ["no_show", "no_show"],
  ["noshow", "no_show"],
  ["no-show", "no_show"],
  ["no show", "no_show"],
]);

// Known statuses that have no target yet: they need a decision, not a guess.
const NEEDS_PRODUCT_DECISION = new Set(["rescheduled"]);

/** Maps a status spelling to its canonical value. Status values are not personal data. */
export function readStatus(value: unknown): BookingStatus | undefined {
  return typeof value === "string" ? STATUS_BY_SPELLING.get(value.trim().toLowerCase()) : undefined;
}

export function normalizeStatus(value: unknown): NormalizeResult<BookingStatus> {
  const status = readStatus(value);
  if (status) return ok(status, value === status ? [] : [warning("STATUS_NORMALIZED", "status")]);

  const spelling = typeof value === "string" ? value.trim().toLowerCase() : typeof value;
  const note = NEEDS_PRODUCT_DECISION.has(spelling) ? "; needs a product decision" : "";
  return reject("INVALID_STATUS", `status "${spelling}" has no mapping${note}`);
}
