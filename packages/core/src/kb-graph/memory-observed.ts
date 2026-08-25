export * as MemoryObserved from "./memory-observed"

import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { MemoryEvent } from "@novaclaw/schema/memory-event"
import { EventV2 } from "../event"
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
 * ⚠️ **The bus is read with `serviceOption`.** Memory is reachable from environments that have no
 * `EventV2` — the `kb` tool's unit fixtures, the absorb evaluator, a bare engine harness — and a
 * hard requirement there would make instrumenting the store a breaking change for every one of
 * them. Where there is no bus there is also no viewer, so a no-op is the honest behaviour rather
 * than a swallowed error.
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
  "qf_" +
  createHash("sha256")
    .update(query.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex")
    .slice(0, 16)

/** Where a recall came from, when the caller says. Unknown is honest, not a default to hide behind. */
export type Surface = MemoryEvent.RecallSurface

const publishing = (run: (events: EventV2.Interface) => Effect.Effect<unknown>) =>
  Effect.serviceOption(EventV2.Service).pipe(
    Effect.flatMap((maybe) =>
      Option.isSome(maybe) ? run(maybe.value).pipe(Effect.ignore, Effect.asVoid) : Effect.void,
    ),
    Effect.ignore,
  )

/**
 * Wrap a client so every lifecycle-changing operation announces itself.
 *
 * The returned interface is behaviourally identical to `inner` — same results, same errors, same
 * ordering. Only the observations are new.
 */
export const observed = (inner: MemoryClient.Interface): MemoryClient.Interface => ({
  ...inner,

  addMemory: (input) =>
    inner.addMemory(input).pipe(
      Effect.tap(() =>
        publishing((events) =>
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
          ? publishing((events) =>
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
    ),

  setClaimStatus: (id, status, access) =>
    inner.setClaimStatus(id, status, access).pipe(
      Effect.tap((changed) =>
        changed
          ? publishing((events) =>
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
      .pipe(Effect.tap(() => publishing((events) => events.publish(MemoryEvent.Forgotten, { id, mode: "invalidate" })))),

  purge: (id, access) =>
    inner
      .purge(id, access)
      .pipe(Effect.tap(() => publishing((events) => events.publish(MemoryEvent.Forgotten, { id, mode: "purge" })))),

  search: (input) =>
    inner.search(input).pipe(
      Effect.tap((hits) =>
        publishing((events) =>
          events.publish(MemoryEvent.Recalled, {
            fingerprint: fingerprint(input.query ?? ""),
            surface: input.surface ?? "unknown",
            scopes: input.scopes ?? [],
            hits: hits.map((hit, index) => ({ id: hit.id, rank: index + 1, score: hit.score, scope: hit.scope })),
            considered: hits.length,
          }),
        ),
      ),
    ),
})
