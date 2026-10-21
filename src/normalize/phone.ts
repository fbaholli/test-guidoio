import { parsePhoneNumberFromString } from "libphonenumber-js";
import { type Ok, ok, warning } from "./result.js";

/**
 * A phone in E.164, read as Italian unless it says otherwise. An unreadable phone is kept out
 * (null) rather than rejecting the person: the rest of the record is still good.
 */
export function normalizePhone(value: unknown, field = "phone"): Ok<string | null> {
  if (value === undefined || value === null || value === "") return ok(null);
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return ok(null, [warning("PHONE_UNPARSEABLE", field)]);

  // parse() digs digits out of almost anything ("chiamami dopo le 18" becomes +3918), so only
  // a number that is valid for its country counts.
  const parsed = parsePhoneNumberFromString(text, "IT");
  if (!parsed?.isValid()) return ok(null, [warning("PHONE_UNPARSEABLE", field)]);

  const e164 = parsed.number;
  return ok(e164, text === e164 ? [] : [warning("PHONE_NORMALIZED", field)]);
}
