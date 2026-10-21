import type { RawDoc } from "../source/types.js";
import type { NormalizeContext } from "./context.js";
import { optionalText, requiredText, unknownFieldsWarning } from "./fields.js";
import { type NormalizeResult, reject, type Warning, warning } from "./result.js";
import { checked, pickupPointRowSchema } from "./schemas.js";

export type PickupPointRow = {
  legacyId: string;
  cityId: string;
  cityLegacyId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: Date;
  legacyUpdatedAt: Date;
};

const KNOWN_FIELDS = new Set(["cityId", "name", "address", "lat", "lng"]);

export function normalizePickupPoint(
  doc: RawDoc,
  context: NormalizeContext,
): NormalizeResult<PickupPointRow> {
  const cityLegacyId = requiredText(doc.data, "cityId");
  if (!cityLegacyId.ok) return cityLegacyId;
  const city = context.cities(cityLegacyId.value);
  if (!city) return reject("ORPHAN_CITY", `cityId ${cityLegacyId.value} not found`);

  const name = requiredText(doc.data, "name");
  if (!name.ok) return name;

  const { lat, lng, warnings } = readCoordinates(doc.data.lat, doc.data.lng);
  const row: PickupPointRow = {
    legacyId: doc.id,
    cityId: city.id,
    cityLegacyId: city.legacyId,
    name: name.value,
    address: optionalText(doc.data.address),
    lat,
    lng,
    createdAt: doc.updateTime,
    legacyUpdatedAt: doc.updateTime,
  };
  return checked(pickupPointRowSchema, row, [
    ...warnings,
    ...unknownFieldsWarning(doc.data, KNOWN_FIELDS),
  ]);
}

/** Both coordinates or neither: half a location is no use for a pickup. */
function readCoordinates(lat: unknown, lng: unknown) {
  const none = { lat: null, lng: null };
  if (lat === undefined && lng === undefined) return { ...none, warnings: [] as Warning[] };
  const valid =
    typeof lat === "number" &&
    typeof lng === "number" &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180;
  return valid
    ? { lat, lng, warnings: [] as Warning[] }
    : { ...none, warnings: [warning("COORDINATES_INVALID", "lat, lng")] };
}
