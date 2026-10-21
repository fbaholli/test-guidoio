import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../../../src/normalize/email.js";
import { normalizePrice } from "../../../src/normalize/money.js";
import { normalizePhone } from "../../../src/normalize/phone.js";
import { normalizeStatus } from "../../../src/normalize/status.js";
import { outcome } from "../../support/normalize.js";

describe("normalizeStatus", () => {
  it.each([
    ["booked", "booked", []],
    ["confirmed", "confirmed", []],
    ["completed", "completed", []],
    ["cancelled", "cancelled", []],
    ["no_show", "no_show", []],
    ["Cancelled", "cancelled", ["STATUS_NORMALIZED"]],
    ["canceled", "cancelled", ["STATUS_NORMALIZED"]],
    [" CONFIRMED ", "confirmed", ["STATUS_NORMALIZED"]],
    ["noshow", "no_show", ["STATUS_NORMALIZED"]],
    ["no-show", "no_show", ["STATUS_NORMALIZED"]],
    ["No Show", "no_show", ["STATUS_NORMALIZED"]],
  ])("maps %j to %s", (input, status, warnings) => {
    const result = normalizeStatus(input);
    expect(outcome(result)).toEqual({ ok: true, warnings });
    expect(result.ok && result.value).toBe(status);
  });

  it.each([["rescheduled"], ["pending"], [""], [3], [undefined]])("rejects %j", (input) => {
    expect(outcome(normalizeStatus(input))).toEqual({ ok: false, reason: "INVALID_STATUS" });
  });

  it("flags rescheduled as needing a product decision", () => {
    const result = normalizeStatus("rescheduled");
    expect(result.ok ? "" : result.detail).toContain("needs a product decision");
  });
});

describe("normalizePhone", () => {
  it.each<[unknown, string | null, string[]]>([
    ["333 123 4567", "+393331234567", ["PHONE_NORMALIZED"]],
    ["0039 333-123-4567", "+393331234567", ["PHONE_NORMALIZED"]],
    ["+39 333 123 4567", "+393331234567", ["PHONE_NORMALIZED"]],
    ["+393331234567", "+393331234567", []],
    ["02 1234 5678", "+390212345678", ["PHONE_NORMALIZED"]],
    ["chiamami dopo le 18", null, ["PHONE_UNPARSEABLE"]],
    ["123", null, ["PHONE_UNPARSEABLE"]],
    [{ number: "333" }, null, ["PHONE_UNPARSEABLE"]],
    [undefined, null, []],
    ["", null, []],
  ])("reads %j as %s", (input, e164, warnings) => {
    const result = normalizePhone(input);
    expect(result.value).toBe(e164);
    expect(result.warnings.map((w) => w.code)).toEqual(warnings);
  });
});

describe("normalizePrice", () => {
  it.each<[unknown, number | null, string[]]>([
    [45, 4500, []],
    [45.5, 4550, []],
    [0, 0, []],
    [19.99, 1999, []],
    ["45,50", 4550, ["PRICE_PARSED_FROM_STRING"]],
    ["45.50", 4550, ["PRICE_PARSED_FROM_STRING"]],
    ["45,5", 4550, ["PRICE_PARSED_FROM_STRING"]],
    [" 45 ", 4500, ["PRICE_PARSED_FROM_STRING"]],
    [undefined, null, ["PRICE_MISSING"]],
    [null, null, ["PRICE_MISSING"]],
  ])("reads %j as %s cents", (input, cents, warnings) => {
    const result = normalizePrice(input);
    expect(outcome(result)).toEqual({ ok: true, warnings });
    expect(result.ok && result.value).toBe(cents);
  });

  it.each([[-5], ["-5"], ["gratis"], ["45,505"], ["1.234,50"], [Number.NaN], [true]])(
    "rejects %j",
    (input) => {
      expect(outcome(normalizePrice(input))).toEqual({ ok: false, reason: "INVALID_PRICE" });
    },
  );
});

describe("normalizeEmail", () => {
  it.each([
    [" Mario.Rossi@Example.com", "Mario.Rossi@Example.com", "mario.rossi@example.com"],
    ["mario.rossi@example.com", "mario.rossi@example.com", "mario.rossi@example.com"],
    ["   ", null, null],
    [undefined, null, null],
    [42, null, null],
  ])("reads %j", (input, email, matchKey) => {
    expect(normalizeEmail(input)).toEqual({ email, matchKey });
  });
});
