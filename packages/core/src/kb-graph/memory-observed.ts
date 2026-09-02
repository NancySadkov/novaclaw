export * as MemoryObserved from "./memory-observed"

import { Effect } from "effect"
import { createHash } from "node:crypto"
import { MemoryEvent } from "@novaclaw/schema/memory-event"
import { ascending } from "@novaclaw/schema/identifier"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { MemoryAccessLedger } from "./access-ledger"
import { MemoryClient } from "./memory-client"

/**
 * The memory store, observed.
 *
 * 🔴 **This wraps the STORE, not any call site**, and that is the whole design. The `kb` tool,
 * auto-recall inside the runner, auto-extraction, the HTTP memory routes and an officer's
 * retirement all reach the graph through one `MemoryClient.Interface`. Wrapping that one interface
 * is what makes "a claim was written" mean the same thing whoever wrote it — publishing from each
 * caller instead gives a Memory app that shows what the surfaces someone remembered to instrument
 * are doing, which is a weaker claim wearing the same words.
 *
 * ⚠️ **Publishing is best-effort and never on the caller's critical path for correctness.** A bus
 * failure must not turn a successful write into a failed one, so every publish is `Effect.ignore`d
 * and the store's own result is returned untouched. This is the same stance as the client itself:
 * memory degrades, it does not take the turn down with it.
 *
 * 🔴 **The bus and the ledger are handed in at CONSTRUCTION, never read per call.** See `Deps` below
 * for the measurement that forced this: an optional per-call service read made every event a silent
 * no-op in the one environment that mattered most, with the whole unit suite green.
 *
 * ⚠️ **Reads that are not recalls publish nothing.** `list`, `graph`, `stats`, `neighbors` and
 * `path` are how the Memory app itself reads the store, and publishing on them would make an open
 * viewer generate the events it is watching. The P2 gate's second half — *closing the viewer adds
 * zero work to the write/recall path* — has a mirror image that is just as important: OPENING it
 * must not add work either.
 */

/** How much of a statement rides the bus for the feed's caption. The store holds the full text. */
const CAPTION_CHARS = 160

const caption = (text: string) => (text.length <= CAPTION_CHARS ? text : text.slice(0, CAPTION_CHARS - 1) + "…")

/**
 * A stable, opaque stand-in for a recall query.
 *
 * Whitespace-folded and lowercased first, so "Where does Ann work?" and "where does ann work?"
 * are the same question to the ledger — the point of a fingerprint is to recognise a repeat, and a
 * digest over raw bytes recognises almost nothing.
 */
export const fingerprint = (query: string): string =>
  "qf_" + createHash("sha256").update(query.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 16)

/** Where a recall came from, when the caller says. Unknown is honest, not a default to hide behind. */
export type Surface = MemoryEvent.RecallSurface

/**
 * What the observed store needs to observe WITH.
 *
 * 🔴 **Both fields are stated at construction, and that is the fix for a measured dead feature.**
 * This wrapper used to read the bus per call with `Effect.serviceOption(EventV2.Service)`. Measured
 * 2026-08-25 on a real serve against a real model: the `kb` tool's node declares no `EventV2` among
 * its dependencies, so at the moment the tool's Effect ran the service was simply not in its
 * environment — `serviceOption` answered `None`, every publish was a silent no-op, and an outside
 * subscriber saw ZERO `memory.*` events across three turns in which the store wrote a claim,
 * corrected it and recalled it. Every unit test passed, because a unit test provides the bus.
 *
 * That is the same shape as `MemoryAccess` on the read side, and it takes the same answer: an
 * OPTIONAL dependency read at the call site means every call site must remember, while a required
 * one at construction means the compiler finds them all. `memory.ts` captures both when it builds
 * the client, which is once per instance, in a context the node graph controls.
 *
 * ⚠️ `ledger` is nullable but NOT optional — a caller must write `ledger: undefined` rather than
 * leave it out. An environment with no database (a bare engine harness) is real; forgetting the
 * ledger by omission is exactly the failure above with a different service in it.
 */
export interface Deps {
  readonly events: EventV2.Interface
  readonly ledger: Database.Interface["db"] | undefined
}

const publishing = (events: EventV2.Interface, run: (events: EventV2.Interface) => Effect.Effect<unknown>) =>
  run(events).pipe(Effect.ignore, Effect.asVoid)

/**
 * The P3 ACCESS LEDGER's write side — the same argument as the bus, one layer more durable.
 *
 * 🔴 It hangs off the STORE, not the call sites, for the reason at the top of this file: "this
 * memory answered that question" has to mean the same thing whether auto-recall, the `kb` tool or
 * the Memory app asked. A ledger fed from instrumented call sites measures the instrumentation.
 *
 * ⚠️ **A missing database is a no-op, never a failed recall.** Environments without one are real —
 * a bare engine harness, the absorb evaluator — and there the honest behaviour is to measure
 * nothing. What is NOT allowed is reaching that state by forgetting to pass it, which is why `Deps`
 * makes `ledger: undefined` something a caller has to write down.
 */
const ledgering = (
  db: Database.Interface["db"] | undefined,
  run: (db: Database.Interface["db"]) => Effect.Effect<unknown>,
) => (db === undefined ? Effect.void : run(db).pipe(Effect.ignore, Effect.asVoid))

/**
 * Wrap a client so every lifecycle-changing operation announces itself.
 *
 * The returned interface is behaviourally identical to `inner` — same results, same errors, same
 * ordering. Only the observations are new.
 */
export const observed = (inner: MemoryClient.Interface, deps: Deps): MemoryClient.Interface => ({
  ...inner,

  addMemory: (input) =>
    inner.addMemory(input).pipe(
      Effect.tap(() =>
        publishing(deps.events, (events) =>
          events.publish(MemoryEvent.ItemRecorded, {
            id: input.id,
            scope: input.scope,
            kind: input.kind,
            ...(input.name === undefined ? {} : { name: input.name }),
            text: caption(input.text),
          }),
        ),
      ),
    ),

  addClaim: (input, access) =>
    inner.addClaim(input, access).pipe(
      Effect.tap((result) =>
        // A refused or empty claim changed nothing, so it announces nothing. A DEDUPED one did
        // change nothing too, but the overlay still wants it: "Nova already knew that" is the
        // answer to a question a person watching a write actually asks.
        result.ok && result.id !== undefined
          ? publishing(deps.events, (events) =>
              events.publish(MemoryEvent.ClaimRecorded, {
                id: result.id!,
                scope: input.scope,
                ...(input.subject === undefined ? {} : { subject: input.subject }),
                ...(input.predicate === undefined ? {} : { predicate: input.predicate }),
                statement: caption(input.statement),
                status: result.status ?? "active",
                identified: result.identified ?? false,
                deduped: result.deduped ?? false,
                superseded: result.superseded,
              }),
            )
          : Effect.void,
      ),
      /**
       * 🔴 WHERE "caused a correction" COMES FROM, and why no model is asked.
       *
       * The lifecycle already returns the ids this claim RETIRED, under the same lock that retired
       * them. If one of those ids is in the access ledger, recall handed that answer to somebody and
       * it has now been corrected — so the correction is charged to it. Deterministic, derived from
       * nothing but the store's own result.
       *
       * ⚠️ Ids the ledger has never seen are charged NOTHING (see `markCorrected`). A claim edited
       * before it was ever recalled cost no one a wrong answer, and counting it would turn the
       * review list into a list of ordinary edits.
       */
      Effect.tap((result) =>
        result.ok && result.superseded.length > 0
          ? ledgering(deps.ledger, (db) =>
              MemoryAccessLedger.markCorrected(db, { ids: result.superseded, at: Date.now() }),
            )
          : Effect.void,
      ),
    ),

  setClaimStatus: (id, status, access) =>
    inner.setClaimStatus(id, status, access).pipe(
      Effect.tap((changed) =>
        changed
          ? publishing(deps.events, (events) =>
              events.publish(MemoryEvent.ClaimStatusChanged, {
                id,
                status,
                reason: status === "archived" ? "archived" : status === "active" ? "restored" : "flagged",
              }),
            )
          : Effect.void,
      ),
    ),

  // `reviewEvidence` returns a COUNT, not the ids it flagged, so there is nothing per-claim to
  // announce and inventing ids here would be a second implementation of the traversal. The viewer
  // learns the shape of the change from the count and reconciles by re-reading — which is the
  // reconcile-then-animate rule this transport is built on.
  reviewEvidence: (locator, access) => inner.reviewEvidence(locator, access),

  invalidate: (id, access, at) =>
    inner
      .invalidate(id, access, at)
      .pipe(
        Effect.tap(() =>
          publishing(deps.events, (events) => events.publish(MemoryEvent.Forgotten, { id, mode: "invalidate" })),
        ),
      ),

  // ⚠️ `purge` exists for SECRETS, so the ledger row goes with the memory. Holding an id and a query
  // fingerprint for something the user asked us to erase is a smaller leak than the text, not an
  // acceptable one. `invalidate` deliberately keeps its rows: the memory is still there.
  purge: (id, access) =>
    inner.purge(id, access).pipe(
      Effect.tap(() =>
        publishing(deps.events, (events) => events.publish(MemoryEvent.Forgotten, { id, mode: "purge" })),
      ),
      Effect.tap(() => ledgering(deps.ledger, (db) => MemoryAccessLedger.forget(db, [id]))),
    ),

  search: (input) =>
    inner.search(input).pipe(
      Effect.tap((hits) => {
        const print = fingerprint(input.query ?? "")
        const surface = input.surface ?? "unknown"
        return publishing(deps.events, (events) =>
          events.publish(MemoryEvent.Recalled, {
            fingerprint: print,
            surface,
            scopes: input.scopes ?? [],
            hits: hits.map((hit, index) => ({ id: hit.id, rank: index + 1, score: hit.score, scope: hit.scope })),
            considered: hits.length,
          }),
        ).pipe(
          Effect.andThen(
            ledgering(deps.ledger, (db) =>
              MemoryAccessLedger.record(db, {
                recallID: input.recallID ?? "rcl_" + ascending(),
                fingerprint: print,
                surface,
                at: Date.now(),
                hits: hits.map((hit, index) => ({
                  id: hit.id,
                  scope: hit.scope,
                  rank: index + 1,
                  score: hit.score,
                  conflictKey: hit.conflictKey,
                })),
              }),
            ),
          ),
        )
      }),
    ),

  // 🔴 Erasing every memory erases the measurement of them. A rollup naming ids that no longer exist
  // is a "never used" list built out of ghosts.
  eraseAll: () =>
    inner.eraseAll().pipe(Effect.tap(() => ledgering(deps.ledger, (db) => MemoryAccessLedger.forgetEverything(db)))),

  /**
   * A cabinet was set aside wholesale — the ledger is told, because nothing else will tell it.
   *
   * 🔴 **`...inner` used to spread this straight through, and the miss was invisible** because
   * `record`'s upsert re-stamps `scope` on every recall and its comment cites this exact operation
   * as the reason. But a retirement moves `agent:<id>` to `retired:<id>:<t>`, and no recall path
   * reads `retired:` — so the memories were never returned again and the re-stamp could never fire
   * for the only case it named. A documented repair that cannot run is worse than none: it stops
   * anyone looking.
   *
   * ⚠️ Wrapped HERE, at the store, for the reason at the top of this file. The one caller today is
   * `agent/retire.ts`; a second one would have had to remember, and would not have.
   */
  moveScope: (from, to) =>
    inner
      .moveScope(from, to)
      .pipe(Effect.tap(() => ledgering(deps.ledger, (db) => MemoryAccessLedger.moveScope(db, from, to)))),

  // Clearing a cabinet clears what the ledger learned about it. A rollup naming ids in a scope the
  // user just emptied is a measurement of memories that no longer exist — and on `session:<id>` it
  // would outlive the chat the confirmation said was removed permanently.
  clearScope: (scope) =>
    inner
      .clearScope(scope)
      .pipe(Effect.tap(() => ledgering(deps.ledger, (db) => MemoryAccessLedger.forgetScope(db, scope)))),
})
