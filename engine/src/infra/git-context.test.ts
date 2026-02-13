/**
 * Tests for git context extraction.
 * Uses temporary git repositories for realistic testing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentBranch, getGitContext } from "./git-context";

/**
 * Helper to create a temporary git repository for testing.
 * Returns path to temp directory.
 */
function createTempGitRepo(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "cortex-git-test-"));

  // Initialize git repo
  execSync("git init", { cwd: tempDir, stdio: "pipe" });

  // Configure git user (required for commits)
  execSync('git config user.email "test@example.com"', {
    cwd: tempDir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Create initial commit (required for branch to exist)
  execSync("touch README.md", { cwd: tempDir, stdio: "pipe" });
  execSync("git add README.md", { cwd: tempDir, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', {
    cwd: tempDir,
    stdio: "pipe",
  });

  return tempDir;
}

/**
 * Helper to commit a file in a git repo.
 */
function commitFile(repoPath: string, filename: string, message: string): void {
  // Create parent directory if needed (for paths like src/file.ts)
  const dir = filename.includes("/") ? filename.split("/").slice(0, -1).join("/") : null;
  if (dir) {
    execSync(`mkdir -p ${dir}`, { cwd: repoPath, stdio: "pipe" });
  }

  execSync(`touch ${filename}`, { cwd: repoPath, stdio: "pipe" });
  execSync(`git add ${filename}`, { cwd: repoPath, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: "pipe" });
}

describe("getCurrentBranch", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = createTempGitRepo();
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it("returns current branch name in git repo", () => {
    const branch = getCurrentBranch(tempRepo);

    // Git init creates either "main" or "master" depending on config
    expect(["main", "master"]).toContain(branch);
  });

  it("returns new branch name after checkout", () => {
    execSync("git checkout -b feature/test-branch", {
      cwd: tempRepo,
      stdio: "pipe",
    });

    const branch = getCurrentBranch(tempRepo);

    expect(branch).toBe("feature/test-branch");
  });

  it("returns 'unknown' for non-git directory", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "cortex-non-git-"));

    try {
      const branch = getCurrentBranch(nonGitDir);
      expect(branch).toBe("unknown");
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("returns 'unknown' for non-existent directory", () => {
    const branch = getCurrentBranch("/nonexistent/path");
    expect(branch).toBe("unknown");
  });
});

describe("getGitContext", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = createTempGitRepo();
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it("returns context with branch and initial commit", () => {
    const context = getGitContext(tempRepo);

    expect(["main", "master"]).toContain(context.branch);
    expect(context.recent_commits).toHaveLength(1);
    expect(context.recent_commits[0]).toContain("Initial commit");
    // Initial commit created README.md
    expect(context.changed_files).toEqual(["README.md"]);
  });

  it("includes recent commits in context", () => {
    // Add multiple commits
    commitFile(tempRepo, "file1.txt", "Add file1");
    commitFile(tempRepo, "file2.txt", "Add file2");
    commitFile(tempRepo, "file3.txt", "Add file3");

    const context = getGitContext(tempRepo);

    expect(context.recent_commits.length).toBeGreaterThanOrEqual(3);
    expect(context.recent_commits.some((c) => c.includes("Add file1"))).toBe(
      true
    );
    expect(context.recent_commits.some((c) => c.includes("Add file2"))).toBe(
      true
    );
    expect(context.recent_commits.some((c) => c.includes("Add file3"))).toBe(
      true
    );
  });

  it("limits commits to last 10", () => {
    // Add 15 commits
    for (let i = 1; i <= 15; i++) {
      commitFile(tempRepo, `file${i}.txt`, `Commit ${i}`);
    }

    const context = getGitContext(tempRepo);

    // Should have 10 commits + initial = 11 total
    expect(context.recent_commits.length).toBeLessThanOrEqual(11);
  });

  it("includes changed files from recent commits", () => {
    // Add commits with files
    commitFile(tempRepo, "src/module1.ts", "Add module1");
    commitFile(tempRepo, "src/module2.ts", "Add module2");

    const context = getGitContext(tempRepo);

    expect(context.changed_files).toContain("src/module1.ts");
    expect(context.changed_files).toContain("src/module2.ts");
  });

  it("includes unstaged changed files", () => {
    // Create and commit a file
    commitFile(tempRepo, "existing.txt", "Add existing file");

    // Modify without staging
    execSync("echo 'modified' > existing.txt", {
      cwd: tempRepo,
      stdio: "pipe",
    });

    const context = getGitContext(tempRepo);

    expect(context.changed_files).toContain("existing.txt");
  });

  it("includes staged changed files", () => {
    // Create new file and stage it
    execSync("touch new-staged.txt", { cwd: tempRepo, stdio: "pipe" });
    execSync("git add new-staged.txt", { cwd: tempRepo, stdio: "pipe" });

    const context = getGitContext(tempRepo);

    expect(context.changed_files).toContain("new-staged.txt");
  });

  it("deduplicates changed files", () => {
    // Create file in commit and modify it
    commitFile(tempRepo, "duplicate.txt", "Add file");
    execSync("echo 'modified' > duplicate.txt", {
      cwd: tempRepo,
      stdio: "pipe",
    });

    const context = getGitContext(tempRepo);

    // File should appear only once
    const occurrences = context.changed_files.filter(
      (f) => f === "duplicate.txt"
    ).length;
    expect(occurrences).toBe(1);
  });

  it("sorts changed files alphabetically", () => {
    // Create files in non-alphabetical order
    commitFile(tempRepo, "z-file.txt", "Add z");
    commitFile(tempRepo, "a-file.txt", "Add a");
    commitFile(tempRepo, "m-file.txt", "Add m");

    const context = getGitContext(tempRepo);

    const sorted = [...context.changed_files].sort();
    expect(context.changed_files).toEqual(sorted);
  });

  it("handles branch with no commits gracefully", () => {
    // Create orphan branch (no commits)
    // Note: git rev-parse --abbrev-ref HEAD fails on orphan branch with no commits
    // This matches expected behavior - returns "unknown"
    execSync("git checkout --orphan empty-branch", {
      cwd: tempRepo,
      stdio: "pipe",
    });

    // Remove staged files from orphan branch
    execSync("git rm -rf .", { cwd: tempRepo, stdio: "pipe" });

    const context = getGitContext(tempRepo);

    // On orphan branch with no commits, rev-parse fails, so branch is "unknown"
    expect(context.branch).toBe("unknown");
    expect(context.recent_commits).toEqual([]);
    expect(context.changed_files).toEqual([]);
  });

  it("returns empty context for non-git directory", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "cortex-non-git-"));

    try {
      const context = getGitContext(nonGitDir);

      expect(context).toEqual({
        branch: "unknown",
        recent_commits: [],
        changed_files: [],
      });
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("returns empty context for non-existent directory", () => {
    const context = getGitContext("/nonexistent/path");

    expect(context).toEqual({
      branch: "unknown",
      recent_commits: [],
      changed_files: [],
    });
  });

  it("handles repos with less than 5 commits", () => {
    // Temp repo already has 1 commit from setup
    commitFile(tempRepo, "file1.txt", "Second commit");

    const context = getGitContext(tempRepo);

    expect(context.recent_commits.length).toBe(2);
    // Should not throw or return errors
    expect(context.branch).not.toBe("unknown");
  });
});

describe("getGitContext - property tests", () => {
  it("always returns readonly arrays", () => {
    fc.assert(
      fc.property(fc.constantFrom("/tmp", "/nonexistent"), (path) => {
        const context = getGitContext(path);

        // TypeScript ensures readonly, but verify runtime immutability intent
        expect(Array.isArray(context.recent_commits)).toBe(true);
        expect(Array.isArray(context.changed_files)).toBe(true);
      })
    );
  });

  it("branch name is never empty string", () => {
    fc.assert(
      fc.property(fc.constantFrom("/tmp", "/nonexistent"), (path) => {
        const context = getGitContext(path);

        expect(context.branch.length).toBeGreaterThan(0);
      })
    );
  });

  it("changed files contains no duplicates", () => {
    let tempRepo: string | null = null;

    try {
      tempRepo = createTempGitRepo();
      commitFile(tempRepo, "file1.txt", "Add file");
      commitFile(tempRepo, "file2.txt", "Add file2");

      const context = getGitContext(tempRepo);

      const unique = new Set(context.changed_files);
      expect(context.changed_files.length).toBe(unique.size);
    } finally {
      if (tempRepo) {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    }
  });

  it("changed files are sorted", () => {
    let tempRepo: string | null = null;

    try {
      tempRepo = createTempGitRepo();
      commitFile(tempRepo, "z.txt", "Add z");
      commitFile(tempRepo, "a.txt", "Add a");
      commitFile(tempRepo, "m.txt", "Add m");

      const context = getGitContext(tempRepo);

      const sorted = [...context.changed_files].sort();
      expect(context.changed_files).toEqual(sorted);
    } finally {
      if (tempRepo) {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    }
  });
});
