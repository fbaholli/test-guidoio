import { isPgError, SQLSTATE } from "../db/errors.js";

export type ErrorBody = { code: string; message: string };

/** An error the API means to return, with its status and a stable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Messages are fixed text: database errors carry row values in their detail, and those
// never go back to the caller.
const BY_SQLSTATE: Record<string, { statusCode: number; body: ErrorBody }> = {
  [SQLSTATE.exclusionViolation]: {
    statusCode: 409,
    body: {
      code: "BOOKING_OVERLAP",
      message: "The instructor or the student already has a lesson at that time.",
    },
  },
  [SQLSTATE.foreignKeyViolation]: {
    statusCode: 422,
    body: {
      code: "UNKNOWN_REFERENCE",
      message: "The booking refers to something that doesn't exist.",
    },
  },
  [SQLSTATE.checkViolation]: {
    statusCode: 422,
    body: { code: "CONSTRAINT_VIOLATION", message: "The booking breaks a data rule." },
  },
};

export function toHttpError(error: unknown): { statusCode: number; body: ErrorBody } | undefined {
  if (error instanceof ApiError)
    return { statusCode: error.statusCode, body: { code: error.code, message: error.message } };
  if (isPgError(error)) return BY_SQLSTATE[error.code];
  return undefined;
}
