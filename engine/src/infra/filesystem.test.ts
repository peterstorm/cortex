import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  withPidLock,
  isStalePidLock,
  writeSurface,
  readSurface,
  ensureGitignored,
  writeTelemetry,
} from './filesystem.js';

describe('filesystem', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('withPidLock', () => {
    it('acquires lock, executes function, releases lock', () => {
      const lockPath = path.join(tmpDir, 'test.lock');
      let executed = false;

      const result = withPidLock(lockPath, () => {
        executed = true;
        // Lock file should exist during execution
        expect(fs.existsSync(lockPath)).toBe(true);
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        expect(pid).toBe(process.pid);
        return 42;
      });

      expect(executed).toBe(true);
      expect(result).toBe(42);
      // Lock should be released after execution
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('releases lock even when function throws', () => {
      const lockPath = path.join(tmpDir, 'test.lock');

      expect(() => {
        withPidLock(lockPath, () => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');

      // Lock should be released after error
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('throws when lock held by current process (same PID)', () => {
      const lockPath = path.join(tmpDir, 'test.lock');

      // Acquire lock first
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid), 'utf8');

      // Try to acquire again with same PID
      expect(() => {
        withPidLock(lockPath, () => {
          // Should not reach here
        });
      }).toThrow(/Lock file already held by running process/);

      // Clean up
      fs.unlinkSync(lockPath);
    });

    it('overrides stale lock (fake dead PID)', () => {
      const lockPath = path.join(tmpDir, 'test.lock');
      const fakePid = 999999999; // PID that doesn't exist

      // Create fake stale lock
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(fakePid), 'utf8');

      let executed = false;
      withPidLock(lockPath, () => {
        executed = true;
        // Should have overridden with current PID
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        expect(pid).toBe(process.pid);
      });

      expect(executed).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('creates parent directory if needed', () => {
      const lockPath = path.join(tmpDir, 'nested', 'dir', 'test.lock');

      withPidLock(lockPath, () => {
        expect(fs.existsSync(lockPath)).toBe(true);
      });

      expect(fs.existsSync(path.dirname(lockPath))).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe('isStalePidLock', () => {
    it('returns false when lock file does not exist', () => {
      const lockPath = path.join(tmpDir, 'nonexistent.lock');
      expect(isStalePidLock(lockPath)).toBe(false);
    });

    it('returns false when lock held by current process', () => {
      const lockPath = path.join(tmpDir, 'current.lock');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid), 'utf8');

      expect(isStalePidLock(lockPath)).toBe(false);

      fs.unlinkSync(lockPath);
    });

    it('returns true when lock held by dead process', () => {
      const lockPath = path.join(tmpDir, 'dead.lock');
      const deadPid = 999999999;

      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(deadPid), 'utf8');

      expect(isStalePidLock(lockPath)).toBe(true);

      fs.unlinkSync(lockPath);
    });

    it('returns false when lock file contains invalid PID', () => {
      const lockPath = path.join(tmpDir, 'invalid.lock');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, 'not-a-number', 'utf8');

      expect(isStalePidLock(lockPath)).toBe(false);

      fs.unlinkSync(lockPath);
    });
  });

  describe('writeSurface and readSurface', () => {
    it('writes and reads surface content', () => {
      const filePath = path.join(tmpDir, 'surface.md');
      const lockDir = tmpDir;
      const content = '# Memory Surface\n\nTest content';

      writeSurface(filePath, content, lockDir);
      const read = readSurface(filePath);

      expect(read).toBe(content);
    });

    it('creates parent directories when writing', () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'surface.md');
      const lockDir = tmpDir;
      const content = 'test';

      writeSurface(filePath, content, lockDir);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(readSurface(filePath)).toBe(content);
    });

    it('returns null when reading non-existent file', () => {
      const filePath = path.join(tmpDir, 'nonexistent.md');
      expect(readSurface(filePath)).toBeNull();
    });

    it('uses PID lock during write (lock released after)', () => {
      const filePath = path.join(tmpDir, 'surface.md');
      const lockDir = tmpDir;
      const lockPath = path.join(lockDir, 'surface.lock');

      writeSurface(filePath, 'test', lockDir);

      // Lock should be released after write
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('overwrites existing surface file', () => {
      const filePath = path.join(tmpDir, 'surface.md');
      const lockDir = tmpDir;

      writeSurface(filePath, 'first', lockDir);
      writeSurface(filePath, 'second', lockDir);

      expect(readSurface(filePath)).toBe('second');
    });
  });

  describe('ensureGitignored', () => {
    it('creates .gitignore with patterns when file does not exist', () => {
      const patterns = ['.memory/', 'cortex-memory.local.md'];

      ensureGitignored(tmpDir, patterns);

      const gitignorePath = path.join(tmpDir, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');

      expect(content).toContain('.memory/');
      expect(content).toContain('cortex-memory.local.md');
    });

    it('appends missing patterns to existing .gitignore', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n', 'utf8');

      const patterns = ['.memory/', '.env', 'cortex-memory.local.md'];
      ensureGitignored(tmpDir, patterns);

      const content = fs.readFileSync(gitignorePath, 'utf8');

      // Existing patterns should remain
      expect(content).toContain('node_modules/');
      expect(content).toContain('.env');

      // New patterns should be added
      expect(content).toContain('.memory/');
      expect(content).toContain('cortex-memory.local.md');

      // .env should not be duplicated
      const envCount = (content.match(/^\.env$/gm) || []).length;
      expect(envCount).toBe(1);
    });

    it('does nothing when all patterns already present', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      const initialContent = '.memory/\ncortex-memory.local.md\n';
      fs.writeFileSync(gitignorePath, initialContent, 'utf8');

      const patterns = ['.memory/', 'cortex-memory.local.md'];
      ensureGitignored(tmpDir, patterns);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toBe(initialContent);
    });

    it('handles .gitignore without trailing newline', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/', 'utf8');

      const patterns = ['.memory/'];
      ensureGitignored(tmpDir, patterns);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toBe('node_modules/\n.memory/\n');
    });

    it('handles empty patterns array', () => {
      ensureGitignored(tmpDir, []);

      const gitignorePath = path.join(tmpDir, '.gitignore');
      // Should not create file when no patterns
      expect(fs.existsSync(gitignorePath)).toBe(false);
    });
  });

  describe('writeTelemetry', () => {
    it('writes telemetry data as formatted JSON', () => {
      const filePath = path.join(tmpDir, 'telemetry.json');
      const data = {
        session_id: 'session-123',
        memories_extracted: 5,
        timestamp: '2024-01-01T00:00:00Z',
      };

      writeTelemetry(filePath, data);

      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(data);
      // Should be formatted with indentation
      expect(content).toContain('  ');
    });

    it('creates parent directories when needed', () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'telemetry.json');
      const data = { test: true };

      writeTelemetry(filePath, data);

      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed).toEqual(data);
    });

    it('overwrites existing telemetry file', () => {
      const filePath = path.join(tmpDir, 'telemetry.json');

      writeTelemetry(filePath, { count: 1 });
      writeTelemetry(filePath, { count: 2 });

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed).toEqual({ count: 2 });
    });

    it('handles complex nested data structures', () => {
      const filePath = path.join(tmpDir, 'telemetry.json');
      const data = {
        session: {
          id: 'session-123',
          metrics: {
            memories: 5,
            edges: 10,
          },
        },
        tags: ['architecture', 'decision'],
        timestamp: '2024-01-01T00:00:00Z',
      };

      writeTelemetry(filePath, data);

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed).toEqual(data);
    });
  });
});
