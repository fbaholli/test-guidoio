import type { LicenseCategory } from "../db/types.js";
import type { RawDoc } from "../source/types.js";
import { compareCodeUnits } from "../util/order.js";
import type { NormalizeContext } from "./context.js";
import { parseInstant } from "./dates.js";
import { normalizeEmail } from "./email.js";
import { isDeleted, requiredText, unknownFieldsWarning } from "./fields.js";
import { readLicenseCategory } from "./license.js";
import { normalizePhone } from "./phone.js";
import { type NormalizeResult, type Warning, warning } from "./result.js";
import { checked, studentRowSchema } from "./schemas.js";

/** One student doc, normalised but not yet merged with its duplicates. */
export type StudentCandidate = {
  legacyId: string;
  cityId: string | null;
  cityLegacyId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  emailKey: string | null;
  phoneE164: string | null;
  taxCode: string | null;
  licenseCategory: LicenseCategory | null;
  deletedAt: Date | null;
  createdAt: Date;
  legacyUpdatedAt: Date;
};

/** The surviving student. `legacyId` is the canonical id; `legacyIds` lists every source doc. */
export type MergedStudent = StudentCandidate & { legacyIds: string[] };

export type StudentMerge = {
  students: MergedStudent[];
  duplicates: Array<{ legacyId: string; mergedInto: string }>;
};

const KNOWN_FIELDS = new Set([
  "firstName",
  "lastName",
  "email",
  "phone",
  "taxCode",
  "cityId",
  "licenseCategory",
  "createdAt",
  "deleted",
]);

export function normalizeStudent(
  doc: RawDoc,
  context: NormalizeContext,
): NormalizeResult<StudentCandidate> {
  const firstName = requiredText(doc.data, "firstName");
  if (!firstName.ok) return firstName;
  const lastName = requiredText(doc.data, "lastName");
  if (!lastName.ok) return lastName;

  const warnings: Warning[] = [];
  const phone = normalizePhone(doc.data.phone);
  warnings.push(...phone.warnings);

  const taxCode = readTaxCode(doc.data.taxCode);
  if (taxCode === undefined) warnings.push(warning("TAX_CODE_INVALID", "taxCode"));

  const licenseCategory = isAbsent(doc.data.licenseCategory)
    ? null
    : readLicenseCategory(doc.data.licenseCategory);
  if (licenseCategory === undefined)
    warnings.push(warning("LICENSE_CATEGORY_INVALID", "licenseCategory"));

  const city = typeof doc.data.cityId === "string" ? context.cities(doc.data.cityId) : undefined;
  if (!isAbsent(doc.data.cityId) && !city) warnings.push(warning("CITY_UNKNOWN", "cityId"));

  const createdAt = parseInstant(doc.data.createdAt, "createdAt", context.timeZone);
  const { email, matchKey } = normalizeEmail(doc.data.email);
  const row: StudentCandidate = {
    legacyId: doc.id,
    cityId: city?.id ?? null,
    cityLegacyId: city?.legacyId ?? null,
    firstName: firstName.value,
    lastName: lastName.value,
    email,
    emailKey: matchKey,
    phoneE164: phone.value,
    taxCode: taxCode ?? null,
    licenseCategory: licenseCategory ?? null,
    // The source only says "deleted", not when; its last update is the best time we have.
    deletedAt: isDeleted(doc.data) ? doc.updateTime : null,
    createdAt: createdAt.ok ? createdAt.value : doc.updateTime,
    legacyUpdatedAt: doc.updateTime,
  };
  return checked(studentRowSchema, row, [
    ...warnings,
    ...unknownFieldsWarning(doc.data, KNOWN_FIELDS),
  ]);
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** null when absent; undefined when present but not a codice fiscale shape. */
function readTaxCode(value: unknown): string | null | undefined {
  if (isAbsent(value)) return null;
  if (typeof value !== "string") return undefined;
  const code = value.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{16}$/.test(code) ? code : undefined;
}

/**
 * Merges students who signed up more than once, matched on normalised email. The oldest
 * sign-up survives (ties broken by doc id); empty fields are filled from the newer ones.
 * Deleted students never merge: they keep their own row. Pure and in memory, which is fine
 * at demo size.
 */
export function mergeDuplicateStudents(candidates: readonly StudentCandidate[]): StudentMerge {
  const groups = new Map<string, StudentCandidate[]>();
  const singles: StudentCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.emailKey === null || candidate.deletedAt !== null) {
      singles.push(candidate);
    } else {
      groups.set(candidate.emailKey, [...(groups.get(candidate.emailKey) ?? []), candidate]);
    }
  }

  const students: MergedStudent[] = singles.map((single) => ({
    ...single,
    legacyIds: [single.legacyId],
  }));
  const duplicates: StudentMerge["duplicates"] = [];
  for (const group of groups.values()) {
    const [survivor, ...others] = [...group].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || compareCodeUnits(a.legacyId, b.legacyId),
    );
    if (!survivor) continue;
    students.push(mergeInto(survivor, others));
    for (const other of others)
      duplicates.push({ legacyId: other.legacyId, mergedInto: survivor.legacyId });
  }

  students.sort((a, b) => compareCodeUnits(a.legacyId, b.legacyId));
  duplicates.sort((a, b) => compareCodeUnits(a.legacyId, b.legacyId));
  return { students, duplicates };
}

function mergeInto(survivor: StudentCandidate, others: StudentCandidate[]): MergedStudent {
  const fill = <K extends keyof StudentCandidate>(field: K): StudentCandidate[K] =>
    [survivor, ...others].map((student) => student[field]).find((value) => value !== null) ??
    survivor[field];
  const city = [survivor, ...others].find((student) => student.cityId !== null) ?? survivor;

  return {
    ...survivor,
    cityId: city.cityId,
    cityLegacyId: city.cityLegacyId,
    phoneE164: fill("phoneE164"),
    taxCode: fill("taxCode"),
    licenseCategory: fill("licenseCategory"),
    // Any duplicate changing counts as the merged student changing.
    legacyUpdatedAt: new Date(
      Math.max(...[survivor, ...others].map((s) => s.legacyUpdatedAt.getTime())),
    ),
    legacyIds: [survivor.legacyId, ...others.map((other) => other.legacyId)].sort(compareCodeUnits),
  };
}
