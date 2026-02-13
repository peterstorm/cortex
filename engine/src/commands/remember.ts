/**
 * Remember command - explicit memory creation with type, priority, scope, pinned flag
 * Thin orchestrator: parse args -> create memory -> insert into DB -> output result
 *
 * Satisfies:
 * - FR-041: Explicit memory creation with content, type, and priority
 * - FR-042: Global vs project scope specification
 * - FR-043: Pin memories to prevent confidence decay
 * - FR-044: Tag memories with arbitrary labels
 * - FR-045: Queue embeddings (embedding=null, local_embedding=null)
 */

import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { MemoryType, MemoryScope, Memory } from '../core/types.js';
import { createMemory, isMemoryType } from '../core/types.js';
import { insertMemory, routeToDatabase } from '../infra/db.js';

// ============================================================================
// FUNCTIONAL CORE - PURE FUNCTIONS
// ============================================================================

/**
 * Parse command line arguments into structured options
 * Pure function - no side effects
 */
export interface RememberArgs {
  readonly content: string;
  readonly type: MemoryType;
  readonly priority: number;
  readonly scope: MemoryScope;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly sessionId: string;
}

export interface ParseResult {
  readonly success: boolean;
  readonly error?: string;
  readonly args?: RememberArgs;
}

/**
 * Parse args array into RememberArgs
 * Pure function for testability
 */
export function parseRememberArgs(
  argv: readonly string[],
  sessionId: string
): ParseResult {
  // Expected format:
  // remember <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=tag1,tag2]

  if (argv.length === 0) {
    return {
      success: false,
      error: 'content is required',
    };
  }

  // First arg is content (may be quoted)
  const content = argv[0].trim();

  if (content === '') {
    return {
      success: false,
      error: 'content must not be empty',
    };
  }

  // Parse options from remaining args
  let type: MemoryType = 'context'; // default
  let priority = 5; // default
  let scope: MemoryScope = 'project'; // default
  let pinned = false; // default
  let tags: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--type=')) {
      const value = arg.substring(7);
      if (!isMemoryType(value)) {
        return {
          success: false,
          error: `invalid memory type: ${value}. Valid types: architecture, decision, pattern, gotcha, context, progress, code_description, code`,
        };
      }
      type = value;
    } else if (arg.startsWith('--priority=')) {
      const value = parseInt(arg.substring(11), 10);
      if (isNaN(value) || value < 1 || value > 10) {
        return {
          success: false,
          error: `priority must be between 1-10, got: ${arg.substring(11)}`,
        };
      }
      priority = value;
    } else if (arg.startsWith('--scope=')) {
      const value = arg.substring(8);
      if (value !== 'project' && value !== 'global') {
        return {
          success: false,
          error: `scope must be 'project' or 'global', got: ${value}`,
        };
      }
      scope = value;
    } else if (arg === '--pinned') {
      pinned = true;
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

  return {
    success: true,
    args: {
      content,
      type,
      priority,
      scope,
      pinned,
      tags,
      sessionId,
    },
  };
}

/**
 * Build Memory object from parsed args
 * Pure function - validates and creates domain object
 *
 * Note: embeddings are null to queue for backfill (FR-045)
 * Summary is derived from content (first 200 chars)
 * Confidence is 1.0 for explicit memories (high trust)
 */
export function buildMemoryFromArgs(args: RememberArgs): Memory {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Generate summary from content (first 200 chars)
  const summary =
    args.content.length <= 200
      ? args.content
      : args.content.substring(0, 197) + '...';

  // Build source_context with session info
  const sourceContext = JSON.stringify({
    source: 'manual',
    session_id: args.sessionId,
  });

  return createMemory({
    id,
    content: args.content,
    summary,
    memory_type: args.type,
    scope: args.scope,
    confidence: 1.0, // Explicit memories have full confidence
    priority: args.priority,
    pinned: args.pinned,
    source_type: 'manual',
    source_session: args.sessionId,
    source_context: sourceContext,
    tags: args.tags,
    embedding: null, // Queue for backfill
    local_embedding: null, // Queue for backfill
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Format success result as JSON
 * Pure function
 */
export interface RememberResult {
  readonly success: true;
  readonly memory_id: string;
  readonly scope: MemoryScope;
  readonly message: string;
}

export function formatSuccessResult(memory: Memory): RememberResult {
  return {
    success: true,
    memory_id: memory.id,
    scope: memory.scope,
    message: `Memory created (${memory.scope} scope, priority ${memory.priority}${memory.pinned ? ', pinned' : ''})`,
  };
}

/**
 * Format error result as JSON
 * Pure function
 */
export interface RememberError {
  readonly success: false;
  readonly error: string;
}

export function formatErrorResult(error: string): RememberError {
  return {
    success: false,
    error,
  };
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Execute remember command
 * I/O boundary - orchestrates pure functions with database operations
 *
 * @param argv - Command arguments (excluding 'remember' command name)
 * @param sessionId - Current session ID
 * @param projectDb - Project database instance
 * @param globalDb - Global database instance
 * @returns JSON result object
 */
export function executeRemember(
  argv: readonly string[],
  sessionId: string,
  projectDb: Database,
  globalDb: Database
): RememberResult | RememberError {
  // Parse args (pure)
  const parseResult = parseRememberArgs(argv, sessionId);

  if (!parseResult.success || !parseResult.args) {
    return formatErrorResult(parseResult.error ?? 'unknown parse error');
  }

  const args = parseResult.args;

  // Build memory object (pure)
  let memory: Memory;
  try {
    memory = buildMemoryFromArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to create memory: ${message}`);
  }

  // Route to appropriate database based on scope (pure routing)
  const targetDb = routeToDatabase(memory.scope, projectDb, globalDb);

  // Insert into database (I/O)
  try {
    insertMemory(targetDb, memory);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to insert memory: ${message}`);
  }

  // Format success result (pure)
  return formatSuccessResult(memory);
}
