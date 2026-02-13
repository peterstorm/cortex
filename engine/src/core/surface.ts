// Surface generator: generates push surface markdown from ranked memories
// Pure functional core - no I/O

import type { Memory, MemoryType } from './types.js';
import { isMemoryType } from './types.js';

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
  readonly maxTokens?: number; // default 500
  readonly allowOverflow?: boolean; // default true (FR-017)
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
  options: SurfaceOptions = {}
): string {
  const maxTokens = options.maxTokens ?? 2000;
  const allowOverflow = options.allowOverflow ?? true;

  if (memories.length === 0) {
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

  // Group by category and render
  const byCategory = groupByCategory(memories);

  for (const [category, mems] of Object.entries(byCategory)) {
    if (mems.length === 0) continue;

    sections.push(`## ${capitalizeCategory(category)}`);
    sections.push('');

    for (const mem of mems) {
      sections.push(`- ${mem.summary}`);
      if (mem.tags.length > 0) {
        sections.push(`  *Tags: ${mem.tags.join(', ')}*`);
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
 * Allocate memories to categories respecting line budgets.
 * High-value memories can overflow (FR-017).
 * Under-budget categories redistribute (FR-018).
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

/**
 * Wrap content in CORTEX_MEMORY markers (FR-024).
 */
export function wrapInMarkers(content: string): string {
  if (!content.trim()) {
    return '';
  }

  return `<!-- CORTEX_MEMORY_START -->
${content}
<!-- CORTEX_MEMORY_END -->`;
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
