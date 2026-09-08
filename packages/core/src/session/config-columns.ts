/**
 * The ROW half of the `SESSION_CONFIG_FIELDS` descriptor (v0.2.0 B2).
 *
 * `config-resolve.ts` is dependency-free on purpose — the merge algebra is unit-tested without a DB
 * — so it names its columns as literal strings. This module is where those strings are cashed in:
 * it imports the real table and the real `Info` schema, checks the names against them AT COMPILE
 * TIME, and generates the two directions `fromRow`/`sessionRow` used to hand-maintain.
 *
 * ⚠️ **Why this exists at all: the "inverse" claim was FALSE for four months and a comment is how
 * it stayed false.** `sessionRow` silently dropped `thinking_budget`, `surgical_edits` and
 * `ask_before_changes`; two of those three are RESTRICTIONS, so a create that meant to restrict
 * produced an unrestricted session and nothing said so. `session-row-inverse.test.ts` catches that
 * class now — but catching is second best. Generating both directions from one descriptor makes
 * the drift unrepresentable, which is the standing preference (ruling 1: an invariant with no
 * mechanical check does not exist; a mechanism beats a check where one is available).
 */
export * as SessionConfigColumns from "./config-columns"

import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import {
  SESSION_CONFIG_FIELDS,
  SESSION_CONFIG_FIELD_KEYS,
  isRowCarried,
  type SessionConfig,
  type SessionConfigColumn,
} from "./config-resolve"
import type { SessionSchema } from "./schema"
import type { SessionTable } from "./sql"

type Row = typeof SessionTable.$inferSelect
type RowInsert = typeof SessionTable.$inferInsert

/**
 * ⚠️ THE CHECK THE DESCRIPTOR'S STRINGS DEPEND ON. Every column name declared in
 * `SESSION_CONFIG_FIELDS` must be a real `session` column. Without this a typo (`safe_modee`) or a
 * column renamed by a migration would compile fine and silently read `undefined` forever — the
 * phantom shape B2 exists to remove, reintroduced one layer down. The `false` branch carries the
 * offending names so the compiler NAMES them instead of only refusing.
 */
type EveryDeclaredColumnExists =
  SessionConfigColumn extends keyof Row ? true : ["not a session column", Exclude<SessionConfigColumn, keyof Row>]
const _everyDeclaredColumnExists: EveryDeclaredColumnExists = true
void _everyDeclaredColumnExists

/** The `session` columns the config descriptor claims, at runtime. Read off the descriptor. */
export const SESSION_CONFIG_COLUMNS: readonly SessionConfigColumn[] = SESSION_CONFIG_FIELD_KEYS.flatMap((key) => {
  const column = SESSION_CONFIG_FIELDS[key].column
  return column === undefined ? [] : [column as SessionConfigColumn]
})

/** The config half of a `Session.Info` — exactly the fields the descriptor governs. */
export type SessionConfigInfoFields = Pick<SessionSchema.Info, keyof SessionConfig>

/**
 * Fields whose ROW shape is not their `Info` shape and therefore need a decoder. Everything else is
 * `row[column] ?? undefined`, which is why the table is two entries long rather than sixteen —
 * keep it that way: a field that needs bespoke handling is usually a field in the wrong place.
 *
 * `?? undefined` is not cosmetic. Drizzle returns SQL NULL as `null`, and the whole inheritance
 * algebra keys on `undefined` meaning INHERIT. A `null` reaching the chain would be a *declared*
 * value that is not one of the field's legal values.
 */
const DECODE: Partial<{ [K in keyof SessionConfig]: (row: Row) => unknown }> = {
  agent: (row) => (row.agent ? AgentV2.ID.make(row.agent) : undefined),
  model: (row) =>
    row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: ModelV2.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
}

/**
 * The config-bearing half of a CREATE input. Structural on purpose, so `SessionV2.CreateInput` stays
 * a local type in `session.ts` and this module keeps its one-way dependency.
 *
 * ⚠️ `model` is the branded `ModelV2.Ref`, not `SessionConfig["model"]`. The chain algebra in
 * `config-resolve.ts` is dependency-free and so carries plain strings; a create input comes off the
 * wire already decoded. That difference is the entire reason this direction needs its own decode
 * table below rather than reusing `DECODE`.
 */
export interface SessionConfigInput extends Omit<SessionConfig, "model"> {
  readonly model?: ModelV2.Ref
}

/**
 * The create direction's decode. One entry, for the same reason `DECODE` has two: a field needing
 * bespoke handling here is usually a field in the wrong place.
 *
 * ⚠️ Deliberately NOT symmetric with `DECODE.model`, and the asymmetry is behaviour-preserving
 * rather than an oversight: the row's `providerID` is a plain string and needs `ProviderV2.ID.make`,
 * while a create input's is already branded. What both share is defaulting an absent `variant` to
 * `"default"` — the one normalisation a caller must not be able to skip.
 */
const INPUT_DECODE: Partial<{ [K in keyof SessionConfig]: (input: SessionConfigInput) => unknown }> = {
  model: (input) =>
    input.model
      ? {
          id: ModelV2.ID.make(input.model.id),
          providerID: input.model.providerID,
          variant: ModelV2.VariantID.make(input.model.variant ?? "default"),
        }
      : undefined,
}

/**
 * Create input → the config half of `Session.Info`. Generated; `create` spreads the result.
 *
 * ⚠️ **Why this exists: `create` was the THIRD hand-written copy of the field list** (the ECS audit,
 * 2026-08-08, found the first two — `CreateInput` itself and the write-path wire). `configFromRow`
 * and `configToRow` were generated in B2 precisely because a hand-maintained list of these fields
 * had silently dropped three of them for four months, two of which were RESTRICTIONS; the create
 * path kept its literal and therefore kept the defect class. A field added to the descriptor now
 * reaches a new session's record without anyone remembering to list it here.
 *
 * ⚠️ It skips fields the row cannot carry, exactly as `configFromRow`/`configToRow` do. Putting a
 * column-less field into the projected `Info` would publish a value that vanishes on the next read —
 * ruling 2's *a fault is never described falsely*, in the create direction. (That set is ratcheted
 * at zero by `session-fork-config.test.ts`, so this is a guard against a future field, not a live
 * filter.)
 */
export const configFromInput = (input: SessionConfigInput): SessionConfigInfoFields => {
  const info: Record<string, unknown> = {}
  for (const key of SESSION_CONFIG_FIELD_KEYS) {
    if (!isRowCarried(key)) continue
    const decode = INPUT_DECODE[key]
    info[key] = decode ? decode(input) : (input as Record<string, unknown>)[key]
  }
  return info as SessionConfigInfoFields
}

/** Row → the config half of `Session.Info`. Generated; `fromRow` spreads the result. */
export const configFromRow = (row: Row): SessionConfigInfoFields => {
  const info: Record<string, unknown> = {}
  for (const key of SESSION_CONFIG_FIELD_KEYS) {
    const column = SESSION_CONFIG_FIELDS[key].column
    if (column === undefined) continue
    const decode = DECODE[key]
    info[key] = decode ? decode(row) : ((row as Record<string, unknown>)[column] ?? undefined)
  }
  return info as SessionConfigInfoFields
}

/**
 * The config half of `Session.Info` → row columns. Generated; `sessionRow` spreads the result.
 *
 * ⚠️ `undefined` is passed through rather than coerced to `null`, deliberately: drizzle OMITS an
 * `undefined` key from a SET clause, which is what lets an unrelated `setTitle` round-trip a whole
 * `Info` without blanking columns the caller never mentioned. Writing `null` here would turn every
 * partial update into a silent reset of every config field.
 */
export const configToRow = (info: SessionConfigInfoFields): Pick<RowInsert, SessionConfigColumn> => {
  const row: Record<string, unknown> = {}
  for (const key of SESSION_CONFIG_FIELD_KEYS) {
    if (!isRowCarried(key)) continue
    row[SESSION_CONFIG_FIELDS[key].column as SessionConfigColumn] = (info as Record<string, unknown>)[key]
  }
  return row as Pick<RowInsert, SessionConfigColumn>
}
