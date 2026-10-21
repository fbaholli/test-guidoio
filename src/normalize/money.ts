import { type NormalizeResult, ok, reject, warning } from "./result.js";

const EUROS_TEXT = /^(\d+)(?:[.,](\d{1,2}))?$/;

/** Euros in, integer cents out. Text is read digit by digit, never through floating point. */
export function normalizePrice(value: unknown, field = "price"): NormalizeResult<number | null> {
  if (value === undefined || value === null) return ok(null, [warning("PRICE_MISSING", field)]);

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      return reject("INVALID_PRICE", `${field} is negative or not finite`);
    return ok(Math.round(value * 100));
  }

  if (typeof value === "string") {
    const match = EUROS_TEXT.exec(value.trim());
    if (!match) return reject("INVALID_PRICE", `${field} is not a readable amount`);
    const [, euros = "0", fraction = ""] = match;
    const cents = Number(euros) * 100 + Number(fraction.padEnd(2, "0"));
    return ok(cents, [warning("PRICE_PARSED_FROM_STRING", field)]);
  }

  return reject("INVALID_PRICE", `${field} is not an amount`);
}
