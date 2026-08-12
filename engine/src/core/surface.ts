// Surface generator: generates push surface markdown from ranked memories
// Pure functional core - no I/O

import type { Memory, MemoryType } from './types.js';
import { isMemoryType } from './types.js';
import type { EntityProfile } from './entities.js';

// Ranked memory - memory with rank attached by ranking module
export type RankedMemory = Memory & { readonly rank: number };

// Per-category line budgets (FR-016)
export const CATEGORY_BUDGETS: Record<MemoryType, number> = {
  architecture: 25,
  decision: 25,
  pattern: 25,
  gotcha: 20,
  progress: 30,
  context: 15,
  code_description: 10,
  code: 0, // code blocks not included in surface (too large)
};

export interface SurfaceOptions {
  readonly maxTokens?: number; // default 2000
}

export interface StalenessInfo {
  readonly stale: boolean;
  readonly age_hours: number;
}

/**
 * Generate push surface markdown from ranked memories.
 * Applies per-category line budgets with overflow and redistribution (FR-016, FR-017, FR-018).
 * Target 300-500 tokens (FR-025).
 */
export function generateSurface(
  memories: readonly RankedMemory[],
  branch: string,
  staleness: StalenessInfo | null,
  options: SurfaceOptions = {},
  entityProfiles: readonly EntityProfile[] = []
): string {
  const maxTokens = options.maxTokens ?? 2000;

  // Entity profiles are rendered even with zero memories — silently dropping
  // non-empty entity knowledge produced an empty surface for entities-only DBs.
  const entitySection = renderEntitySection(entityProfiles);

  if (memories.length === 0 && !entitySection) {
    return '';
  }

  // Memories are already budget-filtered by selectForSurface in ranking.ts.
  // Use them directly to avoid double-filtering.

  // Generate markdown sections
  const sections: string[] = [];

  // Header
  sections.push(`# Cortex Memory Surface`);
  sections.push('');
  sections.push(`**Branch:** ${branch}`);

  if (staleness && staleness.stale) {
    sections.push(`**Warning:** Surface is ${Math.round(staleness.age_hours)}h old. May be stale.`);
  }

  sections.push('');

  // Render entity profiles section early — compact and high-value, survives truncation
  if (entitySection) {
    sections.push(entitySection);
  }

  // Group by category and render
  const byCategory = groupByCategory(memories);

  for (const [category, mems] of Object.entries(byCategory)) {
    if (mems.length === 0) continue;

    sections.push(`## ${capitalizeCategory(category)}`);
    sections.push('');

    for (const mem of mems) {
      // Sanitize at render time: summaries are LLM/user-supplied and must not
      // be able to inject surface markers or break the markdown structure.
      sections.push(`- ${sanitizeSurfaceText(mem.summary)}`);
      if (mem.tags.length > 0) {
        sections.push(`  *Tags: ${sanitizeSurfaceText(mem.tags.join(', '))}*`);
      }
    }

    sections.push('');
  }

  const content = sections.join('\n');

  // Token estimate check (informational)
  const tokens = estimateTokens(content);
  if (tokens > maxTokens * 1.1) {
    // Overflow beyond 10% - truncate
    return truncateToTokens(content, maxTokens);
  }

  return content;
}

/**
 * Sanitize memory-derived text for surface rendering. Pure function.
 *
 * Defends the surface structure against adversarial or accidental content:
 * - Strips CORTEX_* HTML-comment markers — a summary containing
 *   CORTEX_MEMORY_START/END would corrupt the replace-between-markers splice
 *   AND defeat stripInjectedMemorySurface's non-greedy strip in extraction
 *   (leaking surface text back into extraction: a feedback loop).
 * - Collapses newlines to a single space so a summary stays one list item.
 * - Neutralizes leading markdown heading syntax so a summary can't fork the
 *   surface's section structure.
 */
export function sanitizeSurfaceText(text: string): string {
  return text
    .replace(/<!--\s*CORTEX_[A-Z_]*\s*-->/g, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/^\s*#+\s*/, '')
    .trim();
}

/**
 * Splice a marker-wrapped surface block into an existing file's content.
 * Pure function — implements the replace-between-markers contract (FR-024).
 *
 * Behavior:
 * - No existing content (null/blank): the wrapped block becomes the file.
 * - Both markers present in order: replace from START through END (inclusive)
 *   with the new block, preserving everything before and after — user content
 *   outside the markers survives regeneration.
 * - Corrupt markers (only one present, or END before START): conservative
 *   fallback — preserve the existing content untouched and APPEND the new
 *   block at the end. Overwriting would destroy user content we can no
 *   longer delimit; appending self-heals (the appended block has well-formed
 *   markers, so the next regeneration splices normally).
 * - No markers at all: the file is not a cortex-managed surface layout yet
 *   (legacy whole-file surface) — write the wrapped block as the whole file.
 */
export function spliceSurfaceContent(existing: string | null, wrappedBlock: string): string {
  if (existing === null || existing.trim() === '') {
    return wrappedBlock;
  }

  const startIdx = existing.indexOf(SURFACE_START_MARKER);
  const endIdx = existing.indexOf(SURFACE_END_MARKER);
  const hasStart = startIdx !== -1;
  const hasEnd = endIdx !== -1;

  if (hasStart && hasEnd && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + SURFACE_END_MARKER.length);
    return before + wrappedBlock + after;
  }

  if (!hasStart && !hasEnd) {
    // Legacy file without markers: cortex owns the whole file
    return wrappedBlock;
  }

  // Corrupt marker state — never destroy content we can't delimit
  if (!wrappedBlock.trim()) {
    return existing;
  }
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + wrappedBlock + '\n';
}

/**
 * Allocate memories to categories respecting line budgets.
 * High-value memories can overflow (FR-017).
 * Under-budget categories redistribute (FR-018).
 *
 * NOTE: Dead in production — surface selection is done by
 * ranking.ts selectForSurface (token-budget based). Kept because the
 * line-budget redistribution behavior is still covered by tests and may be
 * reused; do not call from new production code without reconciling it with
 * selectForSurface's token accounting.
 */
export function allocateBudget(
  memories: readonly RankedMemory[],
  budgets: Record<MemoryType, number>,
  allowOverflow: boolean
): readonly RankedMemory[] {
  // Group by category
  const byCategory = groupByCategory(memories);

  const allocated: RankedMemory[] = [];

  // First pass: allocate within LINE budgets
  for (const [category, mems] of Object.entries(byCategory)) {
    if (!isMemoryType(category)) continue;
    const budget = budgets[category] ?? 0;
    if (budget === 0) continue; // skip code blocks

    let linesUsed = 0;
    for (const mem of mems) {
      const memLines = estimateLines(mem.summary);
      if (linesUsed + memLines > budget) break;
      allocated.push(mem);
      linesUsed += memLines;
    }
  }

  if (!allowOverflow) {
    return allocated;
  }

  // Second pass: calculate unused LINE budget (across ALL categories, not just those with memories)
  const unusedBudget = Object.entries(budgets).reduce((acc, [category, budget]) => {
    const mems = byCategory[category] ?? [];
    let linesUsed = 0;
    for (const mem of mems) {
      const memLines = estimateLines(mem.summary);
      if (linesUsed + memLines > budget) break;
      linesUsed += memLines;
    }
    return acc + (budget - linesUsed);
  }, 0);

  if (unusedBudget === 0) {
    return allocated;
  }

  // Third pass: redistribute unused budget to high-value overflow memories
  const overflow: RankedMemory[] = [];
  for (const [category, mems] of Object.entries(byCategory)) {
    if (!isMemoryType(category)) continue;
    const budget = budgets[category] ?? 0;

    let linesUsed = 0;
    let overflowStart = 0;
    for (let i = 0; i < mems.length; i++) {
      const memLines = estimateLines(mems[i].summary);
      if (linesUsed + memLines > budget) {
        overflowStart = i;
        break;
      }
      linesUsed += memLines;
    }

    if (overflowStart > 0 || (overflowStart === 0 && linesUsed === 0 && mems.length > 0)) {
      overflow.push(...mems.slice(overflowStart));
    }
  }

  // Sort overflow by rank (highest first) and take up to unused LINE budget
  const sortedOverflow = [...overflow].sort((a, b) => b.rank - a.rank);
  const redistributed: RankedMemory[] = [];
  let remainingBudget = unusedBudget;

  for (const mem of sortedOverflow) {
    const memLines = estimateLines(mem.summary);
    if (memLines <= remainingBudget) {
      redistributed.push(mem);
      remainingBudget -= memLines;
    }
  }

  return [...allocated, ...redistributed];
}

/**
 * Estimate line count for a text string.
 */
function estimateLines(text: string): number {
  return text.split('\n').length;
}

/** Surface block delimiters (FR-024). */
export const SURFACE_START_MARKER = '<!-- CORTEX_MEMORY_START -->';
export const SURFACE_END_MARKER = '<!-- CORTEX_MEMORY_END -->';

/**
 * Wrap content in CORTEX_MEMORY markers (FR-024).
 */
export function wrapInMarkers(content: string): string {
  if (!content.trim()) {
    return '';
  }

  return `${SURFACE_START_MARKER}
${content}
${SURFACE_END_MARKER}`;
}

/**
 * Estimate token count using ~4 chars per token heuristic (FR-025).
 */
export function estimateTokens(text: string): number {
  // Simple heuristic: ~4 characters per token
  return Math.ceil(text.length / 4);
}

// Helper: group memories by category
function groupByCategory(memories: readonly RankedMemory[]): Record<string, RankedMemory[]> {
  const groups: Record<string, RankedMemory[]> = {};

  for (const mem of memories) {
    if (!groups[mem.memory_type]) {
      groups[mem.memory_type] = [];
    }
    groups[mem.memory_type].push(mem);
  }

  return groups;
}

// Helper: capitalize category name for display
function capitalizeCategory(category: string): string {
  return category
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Render entity profiles as a compact surface section.
 * Max 5 entities, max 3 facts each. One line per entity.
 * Pure function.
 */
export function renderEntitySection(
  profiles: readonly EntityProfile[],
  maxEntities: number = 5,
  maxFactsPerEntity: number = 3
): string | null {
  // Filter to entities with at least 1 current fact
  const withFacts = profiles.filter(p => p.currentFacts.length > 0);
  if (withFacts.length === 0) return null;

  const lines: string[] = [];
  lines.push('## Entities');
  lines.push('');

  const selected = withFacts.slice(0, maxEntities);
  for (const profile of selected) {
    const facts = profile.currentFacts
      .slice(0, maxFactsPerEntity)
      .map(f => sanitizeSurfaceText(`${f.predicate}: ${f.object}`))
      .join('; ');
    lines.push(`- **${sanitizeSurfaceText(profile.entity.name)}** (${profile.entity.entity_type}): ${facts}`);
  }

  lines.push('');
  return lines.join('\n');
}

// Helper: truncate content to token limit
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) {
    return content;
  }

  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');

  return lastNewline > 0
    ? truncated.slice(0, lastNewline) + '\n\n*[Truncated to fit token budget]*'
    : truncated + '\n\n*[Truncated to fit token budget]*';
}
