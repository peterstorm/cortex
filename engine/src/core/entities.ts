/**
 * Core domain types for the temporal entity graph layer.
 * Entities represent named things (people, projects, tools, concepts).
 * Facts are temporal assertions about entities (subject-predicate-object triples).
 * Factory functions validate invariants at construction time.
 */

// ============================================================================
// ENTITY TYPES
// ============================================================================

export type EntityType = 'person' | 'project' | 'tool' | 'concept' | 'org' | 'other';

export const ENTITY_TYPES: readonly EntityType[] = [
  'person', 'project', 'tool', 'concept', 'org', 'other',
] as const;

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && ENTITY_TYPES.includes(value as EntityType);
}

// ============================================================================
// DOMAIN OBJECTS
// ============================================================================

export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly entity_type: EntityType;
  readonly aliases: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Fact {
  readonly id: string;
  readonly entity_id: string;
  readonly predicate: string;
  readonly object: string;
  readonly source_memory_id: string;
  readonly confidence: number;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly created_at: string;
}

/** Extracted entity-fact pair from LLM (before DB insertion) */
export interface EntityFactCandidate {
  readonly entity_name: string;
  readonly entity_type: EntityType;
  readonly predicate: string;
  readonly object: string;
}

/** Query result: entity with its current facts */
export interface EntityProfile {
  readonly entity: Entity;
  readonly currentFacts: readonly Fact[];
  readonly sourceMemories: readonly string[];
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createEntity(input: {
  id: string;
  name: string;
  entity_type: EntityType;
  aliases?: readonly string[];
  created_at?: string;
  updated_at?: string;
}): Entity {
  const trimmedName = input.name.trim();
  if (trimmedName === '') {
    throw new Error('Entity name must not be empty');
  }
  if (!isEntityType(input.entity_type)) {
    throw new Error(`Invalid entity type: ${input.entity_type}`);
  }

  const now = new Date().toISOString();
  return {
    id: input.id,
    name: trimmedName,
    entity_type: input.entity_type,
    aliases: [...(input.aliases ?? [])],
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  };
}

export function createFact(input: {
  id: string;
  entity_id: string;
  predicate: string;
  object: string;
  source_memory_id: string;
  confidence: number;
  valid_from: string;
  valid_to?: string | null;
  created_at?: string;
}): Fact {
  if (input.predicate.trim() === '') {
    throw new Error('Fact predicate must not be empty');
  }
  if (input.object.trim() === '') {
    throw new Error('Fact object must not be empty');
  }
  if (Number.isNaN(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Fact confidence must be in [0, 1], got ${input.confidence}`);
  }

  const now = new Date().toISOString();
  return {
    id: input.id,
    entity_id: input.entity_id,
    predicate: input.predicate.trim(),
    object: input.object.trim(),
    source_memory_id: input.source_memory_id,
    confidence: input.confidence,
    valid_from: input.valid_from,
    valid_to: input.valid_to ?? null,
    created_at: input.created_at ?? now,
  };
}

/**
 * Validate an entity-fact candidate from LLM extraction output.
 * Returns true if all required fields are present and valid.
 */
export function isValidEntityFactCandidate(obj: unknown): obj is EntityFactCandidate {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.entity_name === 'string' && c.entity_name.trim() !== '' &&
    isEntityType(c.entity_type) &&
    typeof c.predicate === 'string' && c.predicate.trim() !== '' &&
    typeof c.object === 'string' && c.object.trim() !== ''
  );
}
