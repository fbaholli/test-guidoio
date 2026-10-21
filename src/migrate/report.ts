import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { COLLECTIONS } from "../source/collections.js";
import { compareCodeUnits } from "../util/order.js";
import { type EntityStats, type RunStats, total } from "./stats.js";

// Reports name legacy ids, codes and field names. Never values: the raw docs stay in
// migration_rejects.payload, which is access-restricted.

export const REPORTS_DIR = fileURLToPath(new URL("../../reports/", import.meta.url));

export type RejectSummary = { entity: string; legacyId: string; reason: string; detail: string };

const rejectRows = z.array(
  z.object({
    entity: z.string(),
    legacy_id: z.string(),
    reason_code: z.string(),
    reason_detail: z.string().nullable(),
  }),
);

export async function loadRejectSummaries(pool: pg.Pool, runId: string): Promise<RejectSummary[]> {
  const { rows } = await pool.query(
    "select entity, legacy_id, reason_code, reason_detail from migration_rejects where run_id = $1",
    [runId],
  );
  return rejectRows.parse(rows).map((row) => ({
    entity: row.entity,
    legacyId: row.legacy_id,
    reason: row.reason_code,
    detail: row.reason_detail ?? "",
  }));
}

/** A plain-text table for the console. */
export function renderStatsTable(stats: RunStats): string {
  const header = [
    "entity",
    "read",
    "inserted",
    "updated",
    "unchanged",
    "rejected",
    "warnings",
    "events",
  ];
  const rows = COLLECTIONS.flatMap((name) => {
    const s = stats[name];
    return s ? [[name, ...numbers(s)]] : [];
  });
  return renderTable(header, rows);
}

export function renderCodes(title: string, counter: Record<string, number>): string {
  const rows = Object.entries(counter)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([code, n]) => [code, String(n)]);
  return rows.length === 0 ? `${title}: none` : `${title}\n${renderTable(["code", "count"], rows)}`;
}

export function allCodes(stats: RunStats, kind: "rejected" | "warnings"): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    for (const [code, n] of Object.entries(stats[name]?.[kind] ?? {}))
      totals[code] = (totals[code] ?? 0) + n;
  }
  return totals;
}

export async function writeRunReports(
  kind: "run" | "reconcile",
  runId: string,
  markdown: string,
  json: unknown,
): Promise<{ markdownPath: string; jsonPath: string }> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const markdownPath = join(REPORTS_DIR, `${kind}-${runId}.md`);
  const jsonPath = join(REPORTS_DIR, `${kind}-${runId}.json`);
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

export function backfillMarkdown(
  meta: { runId: string; source: string; dryRun: boolean; resumed: boolean },
  stats: RunStats,
  rejects: RejectSummary[],
): string {
  const sorted = [...rejects].sort(
    (a, b) => compareCodeUnits(a.reason, b.reason) || compareCodeUnits(a.legacyId, b.legacyId),
  );
  return [
    `# Backfill run ${meta.runId}`,
    "",
    `- source: ${meta.source}`,
    `- dry run: ${meta.dryRun ? "yes (everything rolled back)" : "no"}`,
    `- resumed: ${meta.resumed ? "yes" : "no"}`,
    "",
    "## Per entity",
    "",
    markdownTable(
      ["entity", "read", "inserted", "updated", "unchanged", "rejected", "warnings", "events"],
      COLLECTIONS.flatMap((name) => {
        const s = stats[name];
        return s ? [[name, ...numbers(s)]] : [];
      }),
    ),
    "",
    "## Rejects by code",
    "",
    markdownTable(
      ["code", "count"],
      Object.entries(allCodes(stats, "rejected")).map(([c, n]) => [c, String(n)]),
    ),
    "",
    "## Warnings by code",
    "",
    markdownTable(
      ["code", "count"],
      Object.entries(allCodes(stats, "warnings")).map(([c, n]) => [c, String(n)]),
    ),
    "",
    "## Rejected records",
    "",
    "Legacy ids only. The raw documents are in `migration_rejects.payload` (restricted: personal data).",
    "",
    markdownTable(
      ["entity", "legacy id", "reason", "detail"],
      sorted.map((r) => [r.entity, r.legacyId, r.reason, r.detail]),
    ),
    "",
  ].join("\n");
}

function numbers(s: EntityStats): string[] {
  return [
    s.read,
    s.inserted,
    s.updated,
    s.unchanged,
    total(s.rejected),
    total(s.warnings),
    s.events,
  ].map(String);
}

export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function markdownTable(header: string[], rows: string[][]): string {
  if (rows.length === 0) return "_none_";
  const line = (cells: string[]) => `| ${cells.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
