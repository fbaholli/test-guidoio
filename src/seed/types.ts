import type { CollectionName } from "../source/collections.js";

/** A timestamp kept free of the Firebase SDK; each writer turns it into its own format. */
export class SeedTimestamp {
  constructor(readonly iso: string) {}
}

export type SeedValue =
  | string
  | number
  | boolean
  | null
  | SeedTimestamp
  | readonly SeedValue[]
  | SeedFields;

export type SeedFields = { readonly [field: string]: SeedValue };

export type SeedDoc = { readonly id: string; readonly fields: SeedFields };

export type SeedDataset = Readonly<Record<CollectionName, readonly SeedDoc[]>>;

// Array.isArray doesn't narrow readonly arrays, so give TypeScript the hint.
export function isSeedList(value: SeedValue): value is readonly SeedValue[] {
  return Array.isArray(value);
}
