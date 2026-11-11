/**
 * Read admission: which active memories a read may use.
 *
 * Every read the hooks inject — the push surface and the per-prompt recall —
 * takes the same predicate, so a memory refused by one is refused by all.
 * Entity facts follow their source memory. The hooks admit everything; the
 * eval refuses memories that hold its answer key.
 *
 * Pure functional core — no I/O.
 */

import type { Memory } from './types.js';

export type MemoryAdmission = (memory: Memory) => boolean;

export const admitAll: MemoryAdmission = () => true;
