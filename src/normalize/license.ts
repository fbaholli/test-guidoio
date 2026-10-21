import type { LicenseCategory } from "../db/types.js";
import { LICENSE_CATEGORIES } from "./schemas.js";

const KNOWN: ReadonlySet<string> = new Set(LICENSE_CATEGORIES);

export function readLicenseCategory(value: unknown): LicenseCategory | undefined {
  if (typeof value !== "string") return undefined;
  const category = value.trim().toUpperCase();
  return KNOWN.has(category) ? (category as LicenseCategory) : undefined;
}
