import { type NormalizeResult, ok, reject, type Warning, warning } from "./result.js";

// Small readers shared by the entity normalisers.

export function requiredText(
  data: Record<string, unknown>,
  field: string,
): NormalizeResult<string> {
  const value = data[field];
  if (typeof value === "string" && value.trim() !== "") return ok(value.trim());
  return reject("MISSING_REQUIRED_FIELD", `${field} is missing or not text`);
}

export function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Lists fields the target schema doesn't know, so nothing disappears unnoticed. */
export function unknownFieldsWarning(
  data: Record<string, unknown>,
  known: ReadonlySet<string>,
): Warning[] {
  const unknown = Object.keys(data)
    .filter((field) => !known.has(field))
    .sort();
  return unknown.length > 0 ? [warning("UNKNOWN_FIELDS", unknown.join(", "))] : [];
}

/** Compares names the way a person would: spacing and letter case don't count as drift. */
export function sameName(a: string, b: string): boolean {
  const simplify = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
  return simplify(a) === simplify(b);
}

export function isDeleted(data: Record<string, unknown>): boolean {
  return data.deleted === true;
}

/** Collects warnings from several partial results into one list. */
export function collectWarnings(...lists: Warning[][]): Warning[] {
  return lists.flat();
}
