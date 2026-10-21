/**
 * Plain code-unit order, which matches Firestore's document-id order for ASCII ids.
 * `localeCompare` does not: it can rank "_" differently from Firestore.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
