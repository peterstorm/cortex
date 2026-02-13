import type { Memory, MemoryType, SearchResult } from './types.js';
import { CATEGORY_BUDGETS, estimateTokens } from './surface.js';
import { RECENCY_HALF_LIFE_DAYS } from '../config.js';

// Memory with optional centrality (computed at runtime by caller)
type MemoryWithCentrality = Memory & { readonly centrality?: number };

// FR-015: Composite ranking formula
// rank = (confidence * 0.5) + (priority/10 * 0.2) + (centrality * 0.15) + (log(access+1)/maxLog * 0.15)
export function computeRank(
  memory: MemoryWithCentrality,
  options: {
    readonly maxAccessLog: number;
    readonly currentBranch?: string;
    readonly branchBoost?: number;
    readonly recencyHalfLifeDays?: number;
    readonly now?: Date;
  }
): number {
  const { maxAccessLog, currentBranch, branchBoost = 0.1 } = options;

  // Base score components
  const confidenceScore = memory.confidence * 0.5;
  const priorityScore = (memory.priority / 10) * 0.2;
  const centralityScore = (memory.centrality ?? 0) * 0.15;

  // Access frequency score (logarithmic)
  const accessLog = Math.log(memory.access_count + 1);
  const accessScore = maxAccessLog > 0 ? (accessLog / maxAccessLog) * 0.15 : 0;

  // Base rank
  let rank = confidenceScore + priorityScore + centralityScore + accessScore;

  // FR-018: Branch boost for memories tagged with current branch
  if (currentBranch) {
    try {
      const context = JSON.parse(memory.source_context);
      if (typeof context === 'object' && context !== null && context.branch === currentBranch) {
        rank += branchBoost;
      }
    } catch {
      // Invalid JSON in source_context, no boost
    }
  }

  // Recency decay: multiplicative, pinned memories exempt
  if (!memory.pinned) {
    const halfLife = options.recencyHalfLifeDays ?? RECENCY_HALF_LIFE_DAYS;
    const now = options.now ?? new Date();
    const createdAt = new Date(memory.created_at);
    const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyMultiplier = 1 / (1 + Math.max(0, ageDays) / halfLife);
    rank *= recencyMultiplier;
  }

  // Ensure rank is in [0, 1] range
  return Math.max(0, Math.min(1, rank));
}

// FR-016, FR-017, FR-018: Select memories for push surface with category budgets
export function selectForSurface(
  memories: readonly MemoryWithCentrality[],
  options: {
    readonly currentBranch: string;
    readonly targetTokens?: number;
    readonly maxTokens?: number;
    readonly now?: Date;
  }
): readonly (Memory & { readonly rank: number })[] {
  const { currentBranch, targetTokens = 1500, maxTokens = 2000 } = options;
  const now = options.now ?? new Date();

  // Filter out code type (not included in surface)
  const candidates = memories.filter(m => m.memory_type !== 'code');

  // Compute maxAccessLog for ranking
  const maxAccessLog = Math.max(
    ...candidates.map(m => Math.log(m.access_count + 1)),
    1  // Avoid division by zero
  );

  // Rank all candidates
  const ranked = candidates
    .map(memory => ({
      memory,
      rank: computeRank(memory, { maxAccessLog, currentBranch, now })
    }))
    .sort((a, b) => b.rank - a.rank);

  // Category budget tracking
  const categoryUsed: Record<MemoryType, number> = {
    architecture: 0,
    decision: 0,
    pattern: 0,
    gotcha: 0,
    context: 0,
    progress: 0,
    code_description: 0,
    code: 0
  };

  const selected: Array<{ memory: Memory; rank: number }> = [];
  let totalTokens = 0;

  // First pass: select within soft budgets
  for (const item of ranked) {
    const { memory, rank } = item;
    const type = memory.memory_type;
    const budget = CATEGORY_BUDGETS[type];
    const lines = estimateLines(memory.summary);

    // Skip if budget exhausted (soft limit)
    if (categoryUsed[type] >= budget) {
      continue;
    }

    // Skip if would exceed max tokens
    const tokens = estimateTokens(memory.summary);
    if (totalTokens + tokens > maxTokens) {
      break;
    }

    selected.push({ memory, rank });
    categoryUsed[type] += lines;
    totalTokens += tokens;

    // Stop if we hit target
    if (totalTokens >= targetTokens) {
      break;
    }
  }

  // FR-017: Allow overflow for high-value memories if under target
  if (totalTokens < targetTokens) {
    for (const item of ranked) {
      const { memory, rank } = item;
      if (selected.some(s => s.memory.id === memory.id)) continue;

      const tokens = estimateTokens(memory.summary);
      if (totalTokens + tokens > maxTokens) {
        break;
      }

      selected.push({ memory, rank });
      totalTokens += tokens;

      if (totalTokens >= targetTokens) {
        break;
      }
    }
  }

  // Re-sort final selection by rank (fix for overflow pass ordering)
  selected.sort((a, b) => b.rank - a.rank);

  return selected.map(s => ({ ...s.memory, rank: s.rank }));
}

// FR-015: Merge project and global search results, deduplicate, re-rank
export function mergeResults(
  projectResults: readonly SearchResult[],
  globalResults: readonly SearchResult[],
  limit: number
): readonly SearchResult[] {
  // Deduplicate by memory ID (project takes precedence)
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Add project results first
  for (const result of projectResults) {
    if (!seen.has(result.memory.id)) {
      seen.add(result.memory.id);
      merged.push(result);
    }
  }

  // Add global results if not seen
  for (const result of globalResults) {
    if (!seen.has(result.memory.id)) {
      seen.add(result.memory.id);
      merged.push(result);
    }
  }

  // Sort by score descending
  merged.sort((a, b) => b.score - a.score);

  // Return top N
  return merged.slice(0, limit);
}

// Helper: estimate lines (newline count + 1)
function estimateLines(text: string): number {
  return text.split('\n').length;
}
