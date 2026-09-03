export * as MemoryEvent from "./memory-event"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt, optional } from "./schema"

/**
 * What the memory STORE did, published from the store boundary rather than from any call site.
 *
 * 🔴 **The producer must not be able to change what an observer sees.** The `kb` tool, auto-recall
 * inside the runner, auto-extraction, the HTTP memory routes and an officer's retirement all reach
 * the graph through one `MemoryClient.Interface`, so wrapping THAT is what makes "a claim was
 * written" mean the same thing whoever wrote it. Publishing from each caller instead would have
 * produced a Memory app that shows what the surfaces it happens to know about are doing, which is a
 * different and much less useful claim.
 *
 * ⚠️ **These are LIVE events, never durable.** The graph is its own record and `claimHistory` is the
 * timeline; a second, replayable log of the same lifecycle is a copy that drifts. A viewer that
 * misses events reconciles by re-reading the store — which is why every payload carries the ids a
 * reader needs to go and look, and why a lost event costs an animation rather than a fact.
 *
 * ⚠️ **`memory.recalled` carries a FINGERPRINT, never the query.** A recall query is built from the
 * user's own words; putting it on a bus so a viewer can caption it would make every open Memory app
 * a copy of the prompt stream. The fingerprint is enough to say "this is the same question again",
 * which is the only thing the overlay and the P3 ledger need from it.
 */

/** A hashed stand-in for a recall query. Stable across identical queries, opaque otherwise. */
export const QueryFingerprint = Schema.String

/** Where a recall came from, so the overlay can caption an automatic recall differently from a
 *  deliberate `kb search`. */
export const RecallSurface = Schema.Literals(["auto-recall", "kb-tool", "http", "unknown"])
export type RecallSurface = typeof RecallSurface.Type

const Hit = Schema.Struct({
  id: Schema.String,
  /** 1-based, in the order the caller was handed them — the order the overlay highlights in. */
  rank: NonNegativeInt,
  score: Schema.Finite,
  scope: Schema.String,
})

/**
 * A claim was recorded — new, a correction, or a duplicate the lifecycle deduped.
 *
 * `superseded` is what visibly RETIRES in the overlay, and it is the reason this is one event
 * rather than an "added" and a separate "retired": they happen inside one lock, and two events
 * would let a viewer render a moment where neither the old nor the new answer is current.
 */
export const ClaimRecorded = Event.define({
  type: "memory.claim.recorded",
  schema: {
    id: Schema.String,
    scope: Schema.String,
    subject: optional(Schema.String),
    predicate: optional(Schema.String),
    /** Truncated for the feed's caption. The store holds the full text. */
    statement: Schema.String,
    status: Schema.String,
    /** Did the harness accept a conflict identity? `false` = this claim can correct nothing. */
    identified: Schema.Boolean,
    deduped: Schema.Boolean,
    superseded: Schema.Array(Schema.String),
  },
})

/** A plain (non-claim) memory landed: an episode, an entity, an ingested passage. */
export const ItemRecorded = Event.define({
  type: "memory.item.recorded",
  schema: {
    id: Schema.String,
    scope: Schema.String,
    kind: Schema.String,
    name: optional(Schema.String),
    /** Truncated for the feed's caption. */
    text: Schema.String,
  },
})

/**
 * A claim's status moved by a decision rather than by a correction — Archive, Restore, or a
 * `needs_review` flag raised because its evidence moved.
 */
export const ClaimStatusChanged = Event.define({
  type: "memory.claim.status",
  schema: {
    id: Schema.String,
    status: Schema.String,
    /** What raised it. `evidence-moved` is the deterministic one; the others are a person's choice. */
    reason: Schema.Literals(["archived", "restored", "flagged", "evidence-moved"]),
  },
})

/** A memory was invalidated (reversible) or purged (gone). */
export const Forgotten = Event.define({
  type: "memory.forgotten",
  schema: {
    id: Schema.String,
    mode: Schema.Literals(["invalidate", "purge"]),
  },
})

/**
 * The store answered a recall.
 *
 * Published even when nothing matched — an empty recall is the most useful thing the Memory app can
 * show a person wondering why Nova did not remember something.
 */
export const Recalled = Event.define({
  type: "memory.recalled",
  schema: {
    fingerprint: QueryFingerprint,
    surface: RecallSurface,
    scopes: Schema.Array(Schema.String),
    hits: Schema.Array(Hit),
    /** How many the store returned before the caller trimmed to its budget. */
    considered: NonNegativeInt,
  },
})

export const Definitions = Event.inventory(ClaimRecorded, ItemRecorded, ClaimStatusChanged, Forgotten, Recalled)
