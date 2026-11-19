/**
 * Dedupe command: supersede memories that restate a newer one.
 *
 * Imperative shell around core/restatement.ts planRestatements, per database:
 * load the active memories, plan (pure), then apply the whole plan in ONE
 * transaction — each older memory is superseded by the newer one it restates
 * (supersedeMemory: edges and fact sources re-pointed, `supersedes` edge
 * kept → older). No LLM and no model load: it reads the stored current-model
 * vectors.
 *
 * Idempotent: once applied, the survivors contain no restatement, so a second
 * run plans nothing (the planner's own guarantee, see planRestatements).
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { planRestatements, type Restatement } from '../core/restatement.js';
import { getActiveMemories, getMemory, supersedeMemory } from '../infra/db.js';
import { LOCAL_EMBED_MODEL } from '../config.js';

/** One database to dedupe, named for the report. */
export type DedupeTarget = Readonly<{ label: 'project' | 'global'; db: Database }>;

/** A planned or applied restatement, with both summaries for the reader. */
export type DedupePair = Restatement &
  Readonly<{ keptSummary: string; supersededSummary: string }>;

export type DedupeDatabaseReport = Readonly<{
  label: DedupeTarget['label'];
  pairs: readonly DedupePair[];
}>;

export type DedupeOutcome =
  /** The active model has no restatement calibration: nothing was compared. */
  | Readonly<{ kind: 'disabled'; model: string }>
  /** --dry-run: the plan, nothing written. */
  | Readonly<{ kind: 'planned'; databases: readonly DedupeDatabaseReport[] }>
  /** Every pair in `databases` was superseded. */
  | Readonly<{ kind: 'applied'; databases: readonly DedupeDatabaseReport[] }>;

/**
 * Attach both summaries to each planned pair (pure). The plan names only ids
 * from `memories`, so a missing id is a planner bug and fails loudly rather
 * than printing a blank summary.
 */
function describePlan(plan: readonly Restatement[], memories: readonly Memory[]): readonly DedupePair[] {
  const summaries = new Map(memories.map((memory) => [memory.id, memory.summary]));
  const summaryOf = (id: string): string => {
    const summary = summaries.get(id);
    if (summary === undefined) throw new Error(`dedupe plan names unknown memory ${id}`);
    return summary;
  };
  return plan.map((pair) => ({
    ...pair,
    keptSummary: summaryOf(pair.kept),
    supersededSummary: summaryOf(pair.superseded),
  }));
}

/**
 * Apply one database's plan in a single transaction. A pair whose members are
 * no longer both active (another writer got there between the read and the
 * write) is left out, so a concurrent run cannot supersede a memory twice or
 * make a retired memory a replacement.
 */
function applyPlan(db: Database, pairs: readonly DedupePair[]): readonly DedupePair[] {
  return db.transaction((): readonly DedupePair[] => {
    const isActive = (id: string): boolean => getMemory(db, id)?.status === 'active';
    const applied: DedupePair[] = [];
    for (const pair of pairs) {
      if (!isActive(pair.kept) || !isActive(pair.superseded)) continue;
      supersedeMemory(db, pair.superseded, pair.kept);
      applied.push(pair);
    }
    return applied;
  })();
}

/**
 * Plan, and unless `dryRun` apply, the restatement cleanup of each database.
 *
 * @param targets - The databases to dedupe (project and global).
 * @param threshold - The active model's restatement cosine, or null when it
 *   has none (then nothing is compared).
 * @param dryRun - Report the plan without writing.
 */
export function executeDedupe(
  targets: readonly DedupeTarget[],
  threshold: number | null,
  dryRun: boolean
): DedupeOutcome {
  if (threshold === null) return { kind: 'disabled', model: LOCAL_EMBED_MODEL };

  const databases = targets.map(({ label, db }) => {
    const memories = getActiveMemories(db);
    const pairs = describePlan(planRestatements(memories, threshold), memories);
    return { label, pairs: dryRun ? pairs : applyPlan(db, pairs) };
  });
  return dryRun ? { kind: 'planned', databases } : { kind: 'applied', databases };
}

/** Whether an outcome changed anything a cached surface could show. */
export function dedupeChangedMemories(outcome: DedupeOutcome): boolean {
  return outcome.kind === 'applied' && outcome.databases.some((database) => database.pairs.length > 0);
}

const shorten = (text: string): string => (text.length > 100 ? `${text.slice(0, 97)}...` : text);

/** Human-readable report (pure). */
export function formatDedupeOutcome(outcome: DedupeOutcome): string {
  if (outcome.kind === 'disabled') {
    return `Dedupe disabled: ${outcome.model} has no restatement calibration`;
  }
  const verb = outcome.kind === 'planned' ? 'would supersede' : 'superseded';
  const counts = outcome.databases.map((database) => `${database.label} ${database.pairs.length}`).join(', ');
  const total = outcome.databases.reduce((sum, database) => sum + database.pairs.length, 0);
  const header = `Dedupe ${verb} ${total} restatement(s) (${counts})`;
  if (outcome.kind === 'applied') return header;

  const lines = outcome.databases.flatMap((database) =>
    database.pairs.map(
      (pair) =>
        `[${database.label}] cos ${pair.similarity.toFixed(3)}\n` +
        `  keep      ${pair.kept}  ${shorten(pair.keptSummary)}\n` +
        `  supersede ${pair.superseded}  ${shorten(pair.supersededSummary)}`
    )
  );
  return [header, ...lines].join('\n');
}
