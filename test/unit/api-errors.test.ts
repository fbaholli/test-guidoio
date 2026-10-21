import { describe, expect, it } from "vitest";
import { ApiError, toHttpError } from "../../src/api/errors.js";

const pgError = (code: string) =>
  Object.assign(new Error("db error"), { code, detail: "Key (email)=(mario@example.com)" });

describe("toHttpError", () => {
  it.each([
    ["23P01", 409, "BOOKING_OVERLAP"],
    ["23503", 422, "UNKNOWN_REFERENCE"],
    ["23514", 422, "CONSTRAINT_VIOLATION"],
  ])("maps SQLSTATE %s to %i %s", (code, statusCode, errorCode) => {
    expect(toHttpError(pgError(code))).toMatchObject({ statusCode, body: { code: errorCode } });
  });

  it("never echoes the database's detail, which can hold row values", () => {
    expect(JSON.stringify(toHttpError(pgError("23P01")))).not.toContain("mario@example.com");
  });

  it("passes an ApiError through", () => {
    expect(toHttpError(new ApiError(404, "NOT_FOUND", "No booking with that id."))).toEqual({
      statusCode: 404,
      body: { code: "NOT_FOUND", message: "No booking with that id." },
    });
  });

  it.each([[new Error("boom")], [pgError("40001")], ["text"]])(
    "leaves anything else unmapped: %j",
    (error) => {
      expect(toHttpError(error)).toBeUndefined();
    },
  );
});
