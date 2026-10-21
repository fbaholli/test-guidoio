import { describe, expect, it } from "vitest";
import { createLogger, REDACTED } from "../../src/logger.js";

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger("info", { write: (line: string) => lines.push(line) });
  return { logger, lastLine: () => lines.at(-1) ?? "" };
}

describe("createLogger redaction", () => {
  it.each([
    ["a top-level email", { email: "mario@example.com" }, ["email"]],
    [
      "camelCase source fields one level down",
      {
        student: {
          email: "mario@example.com",
          phone: "333 123 4567",
          taxCode: "RSSMRA80A01H501U",
          firstName: "Mario",
          lastName: "Rossi",
        },
        instructor: { fullName: "Giulia Bianchi" },
      },
      [
        "student.email",
        "student.phone",
        "student.taxCode",
        "student.firstName",
        "student.lastName",
        "instructor.fullName",
      ],
    ],
    [
      "snake_case Postgres row fields",
      {
        row: {
          phone_e164: "+393331234567",
          tax_code: "RSSMRA80A01H501U",
          first_name: "Mario",
          last_name: "Rossi",
          full_name: "Giulia Bianchi",
        },
      },
      ["row.phone_e164", "row.tax_code", "row.first_name", "row.last_name", "row.full_name"],
    ],
    [
      "denormalised names and free-text notes",
      { booking: { studentName: "Mario R.", instructorName: "Giulia B.", notes: "call Mario" } },
      ["booking.studentName", "booking.instructorName", "booking.notes"],
    ],
    [
      "the authorization header",
      { req: { headers: { authorization: "Bearer abc123" } } },
      ["req.headers.authorization"],
    ],
  ])("hides %s", (_case, fields, redactedPaths) => {
    const { logger, lastLine } = captureLogger();
    logger.info(fields, "test entry");
    const entry: unknown = JSON.parse(lastLine());

    for (const path of redactedPaths) {
      expect(valueAt(entry, path)).toBe(REDACTED);
    }
  });

  it("keeps fields that aren't personal data", () => {
    const { logger, lastLine } = captureLogger();
    logger.info({ legacyId: "bk_overlap_a", student: { legacyId: "st_dup_rossi_a" } }, "entry");
    const entry: unknown = JSON.parse(lastLine());

    expect(valueAt(entry, "legacyId")).toBe("bk_overlap_a");
    expect(valueAt(entry, "student.legacyId")).toBe("st_dup_rossi_a");
  });

  it("hides row values that Postgres puts in an error's detail", () => {
    const { logger, lastLine } = captureLogger();
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
      detail: "Key (lower(email))=(mario@example.com) already exists.",
    });
    logger.error({ err: error }, "insert failed");

    expect(lastLine()).not.toContain("mario@example.com");
    expect(lastLine()).toContain("duplicate key value");
  });
});

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}
