import { describe, expect, it } from "vitest";
import { ROME_TIME_ZONE } from "../../../src/normalize/context.js";
import { parseInstant } from "../../../src/normalize/dates.js";
import { outcome } from "../../support/normalize.js";

const parse = (value: unknown) => parseInstant(value, "startAt", ROME_TIME_ZONE);

describe("parseInstant", () => {
  it.each<[string, unknown, string, string[]]>([
    [
      "a Firestore Timestamp (a Date)",
      new Date("2026-10-21T12:30:00Z"),
      "2026-10-21T12:30:00.000Z",
      [],
    ],
    ["ISO with an offset", "2026-10-21T14:30:00+02:00", "2026-10-21T12:30:00.000Z", []],
    ["ISO in UTC", "2026-10-21T12:30:00Z", "2026-10-21T12:30:00.000Z", []],
    [
      "Italian local time",
      "21/10/2026 14:30",
      "2026-10-21T12:30:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    [
      "Italian with single digits",
      "1/9/2026 9:05",
      "2026-09-01T07:05:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    [
      "Italian in winter time",
      "21/12/2026 14:30",
      "2026-12-21T13:30:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    [
      "ISO without an offset, read as Rome",
      "2026-10-21T14:30",
      "2026-10-21T12:30:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    ["epoch millis", 1_792_585_800_000, "2026-10-21T12:30:00.000Z", ["DATE_PARSED_FROM_NUMBER"]],
    [
      "the autumn change's repeated 02:30, as its first (summer-time) occurrence",
      "25/10/2026 02:30",
      "2026-10-25T00:30:00.000Z",
      ["DATE_PARSED_FROM_STRING", "DATE_AMBIGUOUS"],
    ],
    [
      "the hour after the autumn change",
      "25/10/2026 03:30",
      "2026-10-25T02:30:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    [
      "the minute before the spring gap",
      "29/03/2026 01:59",
      "2026-03-29T00:59:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
    [
      "the minute after the spring gap",
      "29/03/2026 03:00",
      "2026-03-29T01:00:00.000Z",
      ["DATE_PARSED_FROM_STRING"],
    ],
  ])("reads %s", (_case, value, iso, warnings) => {
    const result = parse(value);
    expect(outcome(result)).toEqual({ ok: true, warnings });
    expect(result.ok && result.value.toISOString()).toBe(iso);
  });

  it.each<[string, unknown, string]>([
    ["words", "domani pomeriggio", "INVALID_DATE"],
    ["a time inside the spring gap", "29/03/2026 02:30", "DST_GAP"],
    ["the very start of the spring gap", "29/03/2026 02:00", "DST_GAP"],
    ["a day that doesn't exist", "31/02/2026 10:00", "INVALID_DATE"],
    ["an American-style date", "10/21/2026 14:30", "INVALID_DATE"],
    ["an epoch in seconds, not millis", 1_792_585_800, "INVALID_DATE"],
    ["a fractional epoch", 1.5, "INVALID_DATE"],
    ["a boolean", true, "INVALID_DATE"],
    ["nothing at all", undefined, "INVALID_DATE"],
    ["an empty string", "", "INVALID_DATE"],
  ])("rejects %s", (_case, value, reason) => {
    expect(outcome(parse(value))).toEqual({ ok: false, reason });
  });

  it("gives the four §3.2 date formats one and the same instant", () => {
    const formats = [
      new Date(1_792_585_800_000),
      "2026-10-21T14:30:00+02:00",
      "21/10/2026 14:30",
      1_792_585_800_000,
    ];
    const instants = formats.map((value) => {
      const result = parse(value);
      return result.ok ? result.value.getTime() : Number.NaN;
    });
    expect(new Set(instants)).toEqual(new Set([1_792_585_800_000]));
  });
});
