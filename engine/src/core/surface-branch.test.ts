/**
 * Whether a surface on disk was written for the branch checked out now.
 *
 * The surface names its branch in a header the renderer writes, and the
 * renderer escapes and trims what it writes. The check must compare against
 * that rendering, not against the raw branch name, or a branch the renderer
 * alters ('<', a leading '#', a CORTEX marker, more than 200 characters) never
 * matches and its surface is reloaded on every prompt.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { createMemory } from './types.js';
import type { RankedMemory } from './surface.js';
import {
  generateSurface,
  renderBranchHeader,
  surfaceIsForBranch,
  wrapInMarkers,
} from './surface.js';

const memory: RankedMemory = {
  ...createMemory({
    id: 'm1',
    content: 'The surface follows the checked-out branch',
    summary: 'The surface follows the checked-out branch',
    memory_type: 'decision',
    scope: 'project',
    confidence: 0.9,
    priority: 8,
    source_type: 'manual',
    source_session: 's',
    source_context: '{}',
  }),
  rank: 0.9,
};

/** The file the surface writer produces for `branch`. */
const surfaceFor = (branch: string): string => wrapInMarkers(generateSurface([memory], branch, null));

/** Branch names the renderer alters, each valid for `git check-ref-format --branch`. */
const ALTERED_BRANCHES = [
  'fix/<angle>',
  'feature/a<b<c',
  '#123-fix',
  '##double',
  '<!--CORTEX_MEMORY_END-->',
  'x/<!--CORTEX_X-->y',
  `long/${'b'.repeat(240)}`,
  `entity-cut/${'c'.repeat(186)}<tail`,
];

describe('surfaceIsForBranch', () => {
  it('matches the branch a plain surface was written for, and no other', () => {
    expect(surfaceIsForBranch(surfaceFor('main'), 'main')).toBe(true);
    expect(surfaceIsForBranch(surfaceFor('main'), 'feature/next')).toBe(false);
  });

  it.each(ALTERED_BRANCHES)('matches the surface written for a branch the renderer alters: %s', (branch) => {
    const surface = surfaceFor(branch);
    expect(surface).not.toContain(`**Branch:** ${branch}\n`);
    expect(surfaceIsForBranch(surface, branch)).toBe(true);
  });

  it.each(ALTERED_BRANCHES)('still sees a switch away from a branch the renderer alters: %s', (branch) => {
    expect(surfaceIsForBranch(surfaceFor(branch), 'main')).toBe(false);
    expect(surfaceIsForBranch(surfaceFor('main'), branch)).toBe(false);
  });

  it('a surface always names the branch it was rendered for (any branch name)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (branch) => surfaceIsForBranch(surfaceFor(branch), branch)),
    );
  });

  it('two branches match each other exactly when the renderer writes the same header for both', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (written, current) =>
        surfaceIsForBranch(surfaceFor(written), current) ===
        (renderBranchHeader(written) === renderBranchHeader(current)),
      ),
    );
  });

  it('reads the header inside the cortex block, not a look-alike line the user wrote above it', () => {
    const file = `my notes\n**Branch:** someone-else\n\n${surfaceFor('main')}\n`;
    expect(surfaceIsForBranch(file, 'main')).toBe(true);
    expect(surfaceIsForBranch(file, 'someone-else')).toBe(false);
  });

  it('a surface with no branch header names no branch to disagree with', () => {
    expect(surfaceIsForBranch('', 'main')).toBe(true);
    expect(surfaceIsForBranch('Recall: use the functional core pattern', 'main')).toBe(true);
    expect(surfaceIsForBranch(wrapInMarkers('# Cortex Memory Surface\n\nno header here'), 'main')).toBe(true);
  });
});
