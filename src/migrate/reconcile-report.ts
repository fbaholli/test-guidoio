import { COLLECTIONS } from "../source/collections.js";
import type { ReconcileResult } from "./reconcile.js";
import { markdownTable, renderTable } from "./report.js";

// Legacy ids and field names only: a reconciliation report must be safe to paste anywhere.

const HEADER = [
  "entity",
  "source docs",
  "pg rows",
  "matched",
  "expected gaps",
  "merged",
  "missing in pg",
  "extra in pg",
  "deleted in source",
  "mismatched",
  "counts ok",
];

function rows(result: ReconcileResult): string[][] {
  return COLLECTIONS.map((name) => {
    const e = result.entities[name];
    return [
      name,
      ...[e.sourceDocs, e.pgRows, e.matched, e.expectedGaps.length, e.mergedDuplicates].map(String),
      ...[
        e.missingInPg.length,
        e.extraInPg.length,
        e.deletedInSource.length,
        e.mismatched.length,
      ].map(String),
      e.countsMatch ? "yes" : "NO",
    ];
  });
}

function problems(result: ReconcileResult): string[] {
  const lines: string[] = [];
  for (const name of COLLECTIONS) {
    const e = result.entities[name];
    for (const id of e.missingInPg) lines.push(`${name} ${id}: missing in Postgres`);
    for (const id of e.extraInPg) lines.push(`${name} ${id}: in Postgres but not in the source`);
    for (const m of e.mismatched)
      lines.push(`${name} ${m.legacyId}: differs in ${m.fields.join(", ")}`);
    if (!e.countsMatch) lines.push(`${name}: source docs ≠ pg rows + rejected + merged duplicates`);
  }
  for (const month of result.differingMonths)
    lines.push(`bookings ${month}: active count or price total differs`);
  return lines;
}

export function renderReconcileSummary(result: ReconcileResult): string {
  const issues = problems(result);
  return [
    renderTable(HEADER, rows(result)),
    "",
    `API-created bookings (left out): ${result.apiRows}`,
    `Monthly totals: ${result.differingMonths.length === 0 ? "match" : `differ in ${result.differingMonths.join(", ")}`}`,
    "",
    ...(issues.length > 0 ? ["Problems:", ...issues.map((line) => `  - ${line}`), ""] : []),
    result.clean ? "RESULT: clean (exit 0)" : "RESULT: NOT clean (exit 1)",
  ].join("\n");
}

export function reconcileMarkdown(result: ReconcileResult, source: string): string {
  const listed = (title: string, pick: (name: (typeof COLLECTIONS)[number]) => string[]) => {
    const entries = COLLECTIONS.flatMap((name) => pick(name).map((id) => [name, id]));
    return [`## ${title}`, "", markdownTable(["entity", "legacy id"], entries), ""];
  };
  return [
    `# Reconciliation ${result.runId}`,
    "",
    `- source: ${source}`,
    `- result: **${result.clean ? "clean" : "NOT clean"}**`,
    `- API-created bookings (left out): ${result.apiRows}`,
    `- monthly totals: ${result.differingMonths.length === 0 ? "match" : `differ in ${result.differingMonths.join(", ")}`}`,
    "",
    "## Per entity",
    "",
    markdownTable(HEADER, rows(result)),
    "",
    "## Mismatched records",
    "",
    markdownTable(
      ["entity", "legacy id", "fields"],
      COLLECTIONS.flatMap((name) =>
        result.entities[name].mismatched.map((m) => [name, m.legacyId, m.fields.join(", ")]),
      ),
    ),
    "",
    ...listed("Missing in Postgres", (name) => result.entities[name].missingInPg),
    ...listed("In Postgres but not in the source", (name) => result.entities[name].extraInPg),
    ...listed(
      "Deleted in the source (soft-deleted in Postgres)",
      (name) => result.entities[name].deletedInSource,
    ),
    ...listed("Expected gaps (rejected by a run)", (name) => result.entities[name].expectedGaps),
  ].join("\n");
}
