import type { LicenseCategory } from "../db/types.js";
import type { RawDoc } from "../source/types.js";
import type { NormalizeContext } from "./context.js";
import { normalizeEmail } from "./email.js";
import { requiredText, unknownFieldsWarning } from "./fields.js";
import { readLicenseCategory } from "./license.js";
import { normalizePhone } from "./phone.js";
import { type NormalizeResult, reject, type Warning, warning } from "./result.js";
import { checked, instructorRowSchema } from "./schemas.js";

export type InstructorRow = {
  legacyId: string;
  cityId: string;
  cityLegacyId: string;
  fullName: string;
  email: string | null;
  phoneE164: string | null;
  licenseCategories: LicenseCategory[];
  active: boolean;
  createdAt: Date;
  legacyUpdatedAt: Date;
};

const KNOWN_FIELDS = new Set([
  "fullName",
  "email",
  "phone",
  "cityId",
  "licenseCategories",
  "active",
]);

export function normalizeInstructor(
  doc: RawDoc,
  context: NormalizeContext,
): NormalizeResult<InstructorRow> {
  const fullName = requiredText(doc.data, "fullName");
  if (!fullName.ok) return fullName;

  const cityLegacyId = requiredText(doc.data, "cityId");
  if (!cityLegacyId.ok) return cityLegacyId;
  const city = context.cities(cityLegacyId.value);
  if (!city) return reject("ORPHAN_CITY", `cityId ${cityLegacyId.value} not found`);

  const phone = normalizePhone(doc.data.phone);
  const categories = readCategories(doc.data.licenseCategories);
  const row: InstructorRow = {
    legacyId: doc.id,
    cityId: city.id,
    cityLegacyId: city.legacyId,
    fullName: fullName.value,
    email: normalizeEmail(doc.data.email).email,
    phoneE164: phone.value,
    licenseCategories: categories.value,
    active: typeof doc.data.active === "boolean" ? doc.data.active : true,
    createdAt: doc.updateTime,
    legacyUpdatedAt: doc.updateTime,
  };
  return checked(instructorRowSchema, row, [
    ...phone.warnings,
    ...categories.warnings,
    ...unknownFieldsWarning(doc.data, KNOWN_FIELDS),
  ]);
}

/** Keeps the categories it recognises, in a stable order, and reports the rest. */
function readCategories(value: unknown): { value: LicenseCategory[]; warnings: Warning[] } {
  if (value === undefined || value === null) return { value: [], warnings: [] };
  const entries = Array.isArray(value) ? value : [value];
  const known = entries.map(readLicenseCategory);
  const categories = [...new Set(known.filter((c): c is LicenseCategory => c !== undefined))];
  const dropped = !Array.isArray(value) || known.includes(undefined);
  return {
    value: categories,
    warnings: dropped ? [warning("LICENSE_CATEGORY_INVALID", "licenseCategories")] : [],
  };
}
