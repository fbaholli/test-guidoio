// SQLSTATE codes we act on. pg errors carry them as `code`, plus the `constraint` name.
export const SQLSTATE = {
  exclusionViolation: "23P01",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  uniqueViolation: "23505",
  notNullViolation: "23502",
} as const;

export type PgError = Error & { code: string; constraint?: string; detail?: string };

export function isPgError(error: unknown): error is PgError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}
