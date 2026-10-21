// Every reason and warning code, in one place. Tests, reports and the decisions doc use these
// exact strings. Details may name fields and legacy ids, never personal data.

export const REJECT_CODES = [
  "MISSING_REQUIRED_FIELD",
  "INVALID_RECORD",
  "ORPHAN_STUDENT",
  "ORPHAN_INSTRUCTOR",
  "ORPHAN_CITY",
  "OVERLAP_INSTRUCTOR",
  "OVERLAP_STUDENT",
  "INVALID_DATE",
  "DST_GAP",
  "INVALID_STATUS",
  "INVALID_DURATION",
  "INVALID_PRICE",
] as const;

export const WARNING_CODES = [
  "DUPLICATE_MERGED",
  "PHONE_UNPARSEABLE",
  "PHONE_NORMALIZED",
  "DATE_PARSED_FROM_STRING",
  "DATE_PARSED_FROM_NUMBER",
  "DATE_AMBIGUOUS",
  "STATUS_NORMALIZED",
  "DURATION_DEFAULTED",
  "PRICE_PARSED_FROM_STRING",
  "PRICE_MISSING",
  "DENORM_DRIFT",
  "UNKNOWN_FIELDS",
  "ORPHAN_PICKUP_POINT",
  "CITY_UNKNOWN",
  "TAX_CODE_INVALID",
  "LICENSE_CATEGORY_INVALID",
  "COORDINATES_INVALID",
  "HISTORY_ENTRY_DROPPED",
] as const;

export type RejectCode = (typeof REJECT_CODES)[number];
export type WarningCode = (typeof WARNING_CODES)[number];

export type Warning = { code: WarningCode; detail?: string };

export type Ok<T> = { ok: true; value: T; warnings: Warning[] };
export type Reject = { ok: false; reason: RejectCode; detail: string };
export type NormalizeResult<T> = Ok<T> | Reject;

export function ok<T>(value: T, warnings: Warning[] = []): Ok<T> {
  return { ok: true, value, warnings };
}

export function reject(reason: RejectCode, detail: string): Reject {
  return { ok: false, reason, detail };
}

export function warning(code: WarningCode, detail?: string): Warning {
  return detail === undefined ? { code } : { code, detail };
}
