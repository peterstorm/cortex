/**
 * Git context extraction for session tagging.
 * Implements FR-003: Extract branch, commits, changed files.
 *
 * Functional core with imperative shell pattern:
 * - Pure transformation of git command output
 * - Side effects isolated to execSync calls
 */

import { execSync } from "node:child_process";
import type { GitContext } from "../core/types.js";

/**
 * Result type for git operations.
 * Either success with value T or failure with error message.
 */
type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Execute git command safely, returning Either.
 * Pure I/O boundary - all side effects isolated here.
 */
function execGit(
  command: string,
  cwd: string
): GitResult<string> {
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], // Ignore stderr to avoid noise
    });
    return { ok: true, value: output.trim() };
  } catch (error) {
    // Command failed - return error
    return { ok: false, error: "git command failed" };
  }
}

/**
 * Parse commits output into array of commit messages.
 * Pure function - transforms git log output.
 *
 * @param output - Raw git log output (one commit per line)
 * @returns Array of commit messages
 */
function parseCommits(output: string): readonly string[] {
  if (output === "") return [];

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Parse changed files from multiple git diff outputs.
 * Pure function - deduplicates and sorts file paths.
 *
 * @param outputs - Array of git diff outputs
 * @returns Deduplicated, sorted array of file paths
 */
function parseChangedFiles(...outputs: readonly string[]): readonly string[] {
  const files = new Set<string>();

  for (const output of outputs) {
    if (output === "") continue;

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "") {
        files.add(trimmed);
      }
    }
  }

  return Array.from(files).sort();
}

/**
 * Get current git branch name.
 * Imperative shell - orchestrates I/O.
 *
 * @param cwd - Working directory
 * @returns Branch name or "unknown" on failure
 */
export function getCurrentBranch(cwd: string): string {
  const result = execGit("git rev-parse --abbrev-ref HEAD", cwd);

  if (!result.ok) return "unknown";

  return result.value || "unknown";
}

/**
 * Get full git context for session tagging.
 * Imperative shell - orchestrates multiple git commands.
 *
 * FR-003: Extract branch name, recent commits, changed files
 *
 * @param cwd - Working directory (must be git repository)
 * @returns GitContext with all extracted information
 */
export function getGitContext(cwd: string): GitContext {
  // Check if directory is a git repository
  const isGitRepo = execGit("git rev-parse --git-dir", cwd);
  if (!isGitRepo.ok) {
    // Not a git repo - return empty context
    return {
      branch: "unknown",
      recent_commits: [],
      changed_files: [],
    };
  }

  // Get branch name
  const branch = getCurrentBranch(cwd);

  // Get recent commits (last 10, oneline format, no decorations)
  const commitsResult = execGit(
    "git log --oneline -10 --no-decorate",
    cwd
  );
  const recent_commits = commitsResult.ok
    ? parseCommits(commitsResult.value)
    : [];

  // Get changed files from multiple sources
  // Use git log to get files from last 5 commits (more reliable than HEAD~5)
  const diffHistory = execGit(
    "git log --name-only --pretty=format: -5",
    cwd
  );
  const diffUnstaged = execGit("git diff --name-only", cwd);
  const diffStaged = execGit("git diff --cached --name-only", cwd);

  const changed_files = parseChangedFiles(
    diffHistory.ok ? diffHistory.value : "",
    diffUnstaged.ok ? diffUnstaged.value : "",
    diffStaged.ok ? diffStaged.value : ""
  );

  return {
    branch,
    recent_commits,
    changed_files,
  };
}
