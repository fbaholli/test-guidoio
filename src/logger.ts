import { type DestinationStream, type LevelWithSilent, type Logger, pino } from "pino";

// Code should never log whole documents or rows; this list is the safety net, not the plan.
// Source docs use camelCase and Postgres rows use snake_case, so both spellings are listed.
const PII_FIELDS = [
  "email",
  "phone",
  "phone_e164",
  "taxCode",
  "tax_code",
  "firstName",
  "lastName",
  "fullName",
  "first_name",
  "last_name",
  "full_name",
  "studentName",
  "instructorName",
  "notes",
] as const;

export const REDACT_PATHS: readonly string[] = [
  ...PII_FIELDS,
  // pino wildcards match exactly one level: `*.email` covers `student.email`, not `a.b.email`.
  ...PII_FIELDS.map((field) => `*.${field}`),
  "req.headers.authorization",
  "password",
  "*.password",
  // pg puts row values in the error detail, e.g. "Key (email)=(mario@example.com) already exists".
  "err.detail",
  // Errors from idle pg connections carry the whole client, connection password included.
  "err.client",
];

export const REDACTED = "[REDACTED]";

export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: [...REDACT_PATHS], censor: REDACTED } };
  return destination ? pino(options, destination) : pino(options);
}
