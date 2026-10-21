import type { RawDoc } from "../source/types.js";
import { optionalText, requiredText, unknownFieldsWarning } from "./fields.js";
import type { NormalizeResult } from "./result.js";
import { checked, cityRowSchema } from "./schemas.js";

export type CityRow = {
  legacyId: string;
  name: string;
  region: string | null;
  createdAt: Date;
  legacyUpdatedAt: Date;
};

const KNOWN_FIELDS = new Set(["name", "region"]);

export function normalizeCity(doc: RawDoc): NormalizeResult<CityRow> {
  const name = requiredText(doc.data, "name");
  if (!name.ok) return name;

  const row: CityRow = {
    legacyId: doc.id,
    name: name.value,
    region: optionalText(doc.data.region),
    createdAt: doc.updateTime,
    legacyUpdatedAt: doc.updateTime,
  };
  return checked(cityRowSchema, row, unknownFieldsWarning(doc.data, KNOWN_FIELDS));
}
