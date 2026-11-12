/**
 * The outcome of one CLI command — exactly one of three things happened.
 *
 * This was a flat bag: a `success` boolean beside independent optional
 * `deferred` and `retryable` flags. Nothing in that shape stopped a handler
 * from returning `success: true` and `deferred: true` at once (which
 * extractionToCommandResult in fact did), or a failure with no error to
 * report, and commandToIngestionStep had to recover the real outcome by
 * testing `deferred` BEFORE `success` — an ordering the compiler could not
 * see, let alone enforce. The union makes those states unrepresentable and
 * turns that recovery into a total switch.
 *
 * It sits between two ADTs on either side (ExtractionResult in,
 * IngestionStepResult out); it is now the same kind of thing they are.
 *
 * Its own module so that the shell pieces the CLI is built from (the project
 * session) can speak it without importing the entry point.
 */
export type CommandResult =
  /** The command did its work. */
  | Readonly<{ kind: 'succeeded'; output?: string }>
  /** The command did no work yet and should be attempted again. */
  | Readonly<{ kind: 'deferred'; output?: string }>
  /** The command failed. `retryable` marks a failure a bounded retry may fix. */
  | Readonly<{ kind: 'failed'; error: string; output?: string; retryable?: boolean }>;
