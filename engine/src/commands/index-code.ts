/**
 * Index-code command - prose-code memory pairing
 *
 * Creates two memories:
 * 1. Prose (code_description) - summary with embedding
 * 2. Code (code) - raw code without embedding
 * Links them via source_of edge (prose -> code)
 *
 * Satisfies:
 * - FR-047: Index code files with prose summaries
 * - FR-048: Store prose as embedded memories (code_description)
 * - FR-049: Store raw code as unembedded memories (code)
 * - FR-050: Link prose/code via source_of edges
 * - FR-051: Track file path and line ranges
 * - FR-052: Support re-indexing (supersede old versions)
 * - FR-053: NEVER send raw code to embedding API
 */

import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { createMemory } from '../core/types.js';
import { buildEmbeddingText } from '../core/extraction.js';
import { insertMemory, insertEdge, updateMemory, routeToDatabase, getActiveCodeMemoriesByFilePath, getActiveProseMemoriesByFilePath } from '../infra/db.js';
import { embedTexts, isGeminiAvailable } from '../infra/gemini-embed.ts';
import { readFileSync } from 'fs';

// ============================================================================
// FUNCTIONAL CORE - PURE FUNCTIONS
// ============================================================================

/**
 * Parse command line arguments
 */
export interface IndexCodeArgs {
  readonly filePath: string;
  readonly summary: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly scope: 'project' | 'global';
  readonly tags: readonly string[];
  readonly sessionId: string;
}

export type ParseResult =
  | { readonly success: true; readonly args: IndexCodeArgs }
  | { readonly success: false; readonly error: string };

/**
 * Parse args array into IndexCodeArgs
 * Pure function for testability
 *
 * Expected format:
 * index-code <file-path> <summary> [--start=N] [--end=N] [--scope=SCOPE] [--tags=tag1,tag2] [--session=ID]
 */
export function parseIndexCodeArgs(
  argv: readonly string[],
  sessionId: string
): ParseResult {
  if (argv.length < 2) {
    return {
      success: false,
      error: 'file path and summary are required',
    };
  }

  const filePath = argv[0].trim();
  const summary = argv[1].trim();

  if (filePath === '') {
    return {
      success: false,
      error: 'file path must not be empty',
    };
  }

  if (summary === '') {
    return {
      success: false,
      error: 'summary must not be empty',
    };
  }

  // Parse options
  let startLine: number | undefined;
  let endLine: number | undefined;
  let scope: 'project' | 'global' = 'project';
  let tags: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--start=')) {
      const value = parseInt(arg.substring(8), 10);
      if (isNaN(value) || value < 1) {
        return {
          success: false,
          error: `start line must be >= 1, got: ${arg.substring(8)}`,
        };
      }
      startLine = value;
    } else if (arg.startsWith('--end=')) {
      const value = parseInt(arg.substring(6), 10);
      if (isNaN(value) || value < 1) {
        return {
          success: false,
          error: `end line must be >= 1, got: ${arg.substring(6)}`,
        };
      }
      endLine = value;
    } else if (arg.startsWith('--scope=')) {
      const value = arg.substring(8);
      if (value !== 'project' && value !== 'global') {
        return {
          success: false,
          error: `scope must be 'project' or 'global', got: ${value}`,
        };
      }
      scope = value;
    } else if (arg.startsWith('--tags=')) {
      const value = arg.substring(7);
      tags = value.split(',').map((t) => t.trim()).filter((t) => t !== '');
    } else {
      return {
        success: false,
        error: `unknown option: ${arg}`,
      };
    }
  }

  // Validate line range
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return {
      success: false,
      error: `start line (${startLine}) must be <= end line (${endLine})`,
    };
  }

  return {
    success: true,
    args: {
      filePath,
      summary,
      startLine,
      endLine,
      scope,
      tags,
      sessionId,
    },
  };
}

/**
 * Extract line range from file content
 * Pure function
 */
export function extractLineRange(
  content: string,
  startLine?: number,
  endLine?: number
): string {
  if (startLine === undefined && endLine === undefined) {
    return content;
  }

  const lines = content.split('\n');

  // Convert 1-based line numbers to 0-based array indices
  const start = startLine !== undefined ? startLine - 1 : 0;
  const end = endLine !== undefined ? endLine : lines.length;

  return lines.slice(start, end).join('\n');
}

/**
 * Build source_context JSON for code memories
 * Pure function
 */
export function buildCodeSourceContext(
  filePath: string,
  startLine?: number,
  endLine?: number,
  sessionId?: string
): string {
  return JSON.stringify({
    file_path: filePath,
    start_line: startLine,
    end_line: endLine,
    session_id: sessionId,
  });
}

/**
 * Build prose memory (code_description with embedding)
 * Pure function — id and timestamp injected from caller
 */
export function buildProseMemory(
  args: IndexCodeArgs,
  embedding: Float64Array | null,
  id: string,
  now: string
): Memory {

  return createMemory({
    id,
    content: args.summary,
    summary: args.summary.length <= 200 ? args.summary : args.summary.substring(0, 197) + '...',
    memory_type: 'code_description',
    scope: args.scope,
    confidence: 1.0, // Explicit indexing = high confidence
    priority: 7, // Default high priority for code
    pinned: false,
    source_type: 'code_index',
    source_session: args.sessionId,
    source_context: buildCodeSourceContext(args.filePath, args.startLine, args.endLine, args.sessionId),
    tags: args.tags,
    embedding: embedding,
    local_embedding: null, // Only Gemini for now
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Build code memory (raw code, NO embedding per FR-053)
 * Pure function — id and timestamp injected from caller
 */
export function buildCodeMemory(
  args: IndexCodeArgs,
  codeContent: string,
  id: string,
  now: string
): Memory {

  // Summary is first 200 chars of code
  const codeSummary = codeContent.length <= 200
    ? codeContent
    : codeContent.substring(0, 197) + '...';

  return createMemory({
    id,
    content: codeContent,
    summary: codeSummary,
    memory_type: 'code',
    scope: args.scope,
    confidence: 1.0,
    priority: 5, // Medium priority for raw code
    pinned: false,
    source_type: 'code_index',
    source_session: args.sessionId,
    source_context: buildCodeSourceContext(args.filePath, args.startLine, args.endLine, args.sessionId),
    tags: args.tags,
    embedding: null, // FR-053: NEVER embed raw code
    local_embedding: null,
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Format success result
 * Pure function
 */
export interface IndexCodeResult {
  readonly success: true;
  readonly prose_memory_id: string;
  readonly code_memory_id: string;
  readonly scope: 'project' | 'global';
  readonly file_path: string;
  readonly superseded_count: number;
  readonly message: string;
}

export function formatSuccessResult(
  proseMemory: Memory,
  codeMemory: Memory,
  filePath: string,
  supersededCount: number
): IndexCodeResult {
  return {
    success: true,
    prose_memory_id: proseMemory.id,
    code_memory_id: codeMemory.id,
    scope: proseMemory.scope,
    file_path: filePath,
    superseded_count: supersededCount,
    message: `Code indexed (${proseMemory.scope} scope, ${supersededCount} old versions superseded)`,
  };
}

/**
 * Format error result
 * Pure function
 */
export interface IndexCodeError {
  readonly success: false;
  readonly error: string;
}

export function formatErrorResult(error: string): IndexCodeError {
  return {
    success: false,
    error,
  };
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Execute index-code command
 * I/O boundary - orchestrates pure functions with file I/O, DB, and API calls
 *
 * Data flow:
 * 1. Parse args (pure)
 * 2. Read file content (I/O)
 * 3. Extract line range (pure)
 * 4. Embed prose summary via Voyage (I/O) - NOT raw code (FR-053)
 * 5. Check for existing code memories at same file_path (I/O)
 * 6. Mark existing as superseded (I/O)
 * 7. Insert prose memory (I/O)
 * 8. Insert code memory (I/O)
 * 9. Link via source_of edge (I/O)
 *
 * @param argv - Command arguments (excluding 'index-code' command name)
 * @param sessionId - Current session ID
 * @param projectDb - Project database instance
 * @param globalDb - Global database instance
 * @param geminiApiKey - Gemini API key (optional)
 * @param projectName - Project name for embedding metadata
 * @returns JSON result object
 */
export async function executeIndexCode(
  argv: readonly string[],
  sessionId: string,
  projectDb: Database,
  globalDb: Database,
  geminiApiKey: string | undefined,
  projectName: string
): Promise<IndexCodeResult | IndexCodeError> {
  // Parse args (pure)
  const parseResult = parseIndexCodeArgs(argv, sessionId);

  if (!parseResult.success) {
    return formatErrorResult(parseResult.error);
  }

  const args = parseResult.args;

  // Read file content (I/O)
  let fileContent: string;
  try {
    fileContent = readFileSync(args.filePath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to read file: ${message}`);
  }

  // Extract line range (pure)
  const codeContent = extractLineRange(fileContent, args.startLine, args.endLine);

  if (codeContent.trim() === '') {
    return formatErrorResult('extracted code is empty');
  }

  // Embed prose summary via Gemini (I/O) - FR-053: ONLY prose, NOT code
  let proseEmbedding: Float64Array | null = null;

  if (isGeminiAvailable(geminiApiKey)) {
    process.stderr.write(`[cortex:index-code] INFO: Using Gemini to embed prose summary\n`);
    try {
      // Build embedding text with metadata prefix
      const embeddingText = buildEmbeddingText(
        {
          content: args.summary,
          summary: args.summary,
          memory_type: 'code_description',
          scope: args.scope,
          confidence: 1.0,
          priority: 7,
          tags: args.tags,
        },
        projectName
      );

      // Embed only the prose summary
      const embeddings = await embedTexts([embeddingText], geminiApiKey!);
      proseEmbedding = embeddings[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal: queue embedding for backfill
      console.error(`Warning: failed to embed prose, will queue for backfill: ${message}`);
    }
  } else {
    process.stderr.write(`[cortex:index-code] INFO: Gemini unavailable — prose embedding queued for backfill\n`);
  }

  // Build memories (pure — ids and timestamps generated at I/O boundary)
  const now = new Date().toISOString();
  const proseMemory = buildProseMemory(args, proseEmbedding, randomUUID(), now);
  const codeMemory = buildCodeMemory(args, codeContent, randomUUID(), now);

  // Route to appropriate database
  const targetDb = routeToDatabase(args.scope, projectDb, globalDb);

  // FR-052: Re-indexing support - find existing code AND prose memories for this file
  let matchingCodeMemories: readonly Memory[] = [];
  let matchingProseMemories: readonly Memory[] = [];
  try {
    matchingCodeMemories = getActiveCodeMemoriesByFilePath(targetDb, args.filePath);
    matchingProseMemories = getActiveProseMemoriesByFilePath(targetDb, args.filePath);
  } catch (err) {
    // Non-fatal: continue without superseding
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to find existing memories: ${message}`);
  }

  // All DB writes in a single transaction for atomicity
  let supersededCount = 0;
  try {
    const tx = targetDb.transaction(() => {
      // Insert memories
      insertMemory(targetDb, proseMemory);
      insertMemory(targetDb, codeMemory);

      // Supersede old code memories
      for (const oldMemory of matchingCodeMemories) {
        if (oldMemory.status === 'active') {
          updateMemory(targetDb, oldMemory.id, { status: 'superseded' });
          supersededCount++;

          insertEdge(targetDb, {
            source_id: codeMemory.id,
            target_id: oldMemory.id,
            relation_type: 'supersedes',
            strength: 1.0,
            bidirectional: false,
            status: 'active',
          });
        }
      }

      // Supersede old prose (code_description) memories
      for (const oldProse of matchingProseMemories) {
        if (oldProse.status === 'active') {
          updateMemory(targetDb, oldProse.id, { status: 'superseded' });
          supersededCount++;

          insertEdge(targetDb, {
            source_id: proseMemory.id,
            target_id: oldProse.id,
            relation_type: 'supersedes',
            strength: 1.0,
            bidirectional: false,
            status: 'active',
          });
        }
      }

      // FR-050: Link prose -> code via source_of edge
      insertEdge(targetDb, {
        source_id: proseMemory.id,
        target_id: codeMemory.id,
        relation_type: 'source_of',
        strength: 1.0,
        bidirectional: false,
        status: 'active',
      });
    });

    tx();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to write memories: ${message}`);
  }

  // Format success result (pure)
  return formatSuccessResult(proseMemory, codeMemory, args.filePath, supersededCount);
}
