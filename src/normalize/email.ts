export type NormalizedEmail = {
  /** Stored as the person typed it, minus surrounding spaces. */
  email: string | null;
  /** Lower-cased: what duplicates are matched on, and what the unique index compares. */
  matchKey: string | null;
};

export function normalizeEmail(value: unknown): NormalizedEmail {
  if (typeof value !== "string" || value.trim() === "") return { email: null, matchKey: null };
  const email = value.trim();
  return { email, matchKey: email.toLowerCase() };
}
