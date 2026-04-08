/**
 * Entity query command — entity-first temporal retrieval.
 * "What do I know about X?" → entity lookup → current facts → source memories.
 *
 * Imperative shell — orchestrates I/O with pure formatting.
 */

import type { Database } from 'bun:sqlite';
import type { EntityProfile } from '../core/entities.js';
import {
  getEntityByName,
  searchEntities,
  getCurrentFacts,
  getAllFacts,
  getMemoriesByIds,
} from '../infra/db.js';

export type EntityQueryOptions = {
  readonly query: string;
  readonly includeHistory?: boolean;
  readonly limit?: number;
};

export type EntityQueryResult = {
  readonly profiles: readonly EntityProfile[];
  readonly method: 'exact' | 'fts';
};

/**
 * Execute entity query: find entity, get current facts, resolve source memories.
 * Searches both project and global databases.
 * I/O boundary.
 */
export function executeEntityQuery(
  projectDb: Database,
  globalDb: Database,
  options: EntityQueryOptions
): EntityQueryResult {
  const { query, includeHistory = false, limit = 5 } = options;

  // Try exact match first (both DBs)
  const exactMatches: EntityProfile[] = [];
  for (const db of [projectDb, globalDb]) {
    const entity = getEntityByName(db, query);
    if (entity && !exactMatches.some(p => p.entity.name.toLowerCase() === entity.name.toLowerCase())) {
      const facts = includeHistory
        ? getAllFacts(db, entity.id)
        : getCurrentFacts(db, entity.id);
      const sourceIds = [...new Set(facts.map(f => f.source_memory_id))];
      const sourceMemories = getMemoriesByIds(db, sourceIds);
      exactMatches.push({
        entity,
        currentFacts: facts,
        sourceMemories: sourceMemories.map(m => m.id),
      });
    }
  }

  if (exactMatches.length > 0) {
    return { profiles: exactMatches.slice(0, limit), method: 'exact' };
  }

  // Fallback to FTS5 search
  const ftsProfiles: EntityProfile[] = [];
  for (const db of [projectDb, globalDb]) {
    const entities = searchEntities(db, query, limit);
    for (const entity of entities) {
      if (ftsProfiles.some(p => p.entity.name.toLowerCase() === entity.name.toLowerCase())) continue;
      const facts = includeHistory
        ? getAllFacts(db, entity.id)
        : getCurrentFacts(db, entity.id);
      const sourceIds = [...new Set(facts.map(f => f.source_memory_id))];
      const sourceMemories = getMemoriesByIds(db, sourceIds);
      ftsProfiles.push({
        entity,
        currentFacts: facts,
        sourceMemories: sourceMemories.map(m => m.id),
      });
    }
  }

  return { profiles: ftsProfiles.slice(0, limit), method: 'fts' };
}

/**
 * Format entity query result as human-readable markdown.
 * Pure function.
 */
export function formatEntityQueryResult(result: EntityQueryResult): string {
  if (result.profiles.length === 0) {
    return `No entities found (method: ${result.method})`;
  }

  const lines: string[] = [];
  lines.push(`Found ${result.profiles.length} entity/entities (${result.method} match):\n`);

  for (const profile of result.profiles) {
    const { entity, currentFacts } = profile;
    lines.push(`## ${entity.name} (${entity.entity_type})`);

    if (entity.aliases.length > 0) {
      lines.push(`**Aliases:** ${entity.aliases.join(', ')}`);
    }

    if (currentFacts.length === 0) {
      lines.push('No facts recorded.');
    } else {
      lines.push('**Facts:**');
      for (const fact of currentFacts) {
        const status = fact.valid_to ? ' [superseded]' : '';
        lines.push(`  - ${fact.predicate}: ${fact.object}${status}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
