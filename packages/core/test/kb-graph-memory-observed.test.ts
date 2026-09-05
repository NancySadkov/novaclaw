import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { MemoryObserved } from "@novaclaw/core/kb-graph/memory-observed"
import { testEffect } from "./lib/effect"

/**
 * `` P2 — **the graph watches STORE events, not agent call sites.**
 *
 * The claim under test is not "these events exist"; it is that they come from the STORE, so every
 * producer behaves identically. The way to test that is to drive the wrapper through the ordinary
 * `MemoryClient.Interface` — the same surface the `kb` tool, auto-recall, auto-extraction and the
 * HTTP routes all hold — and watch the bus. Nothing here knows about any call site, which is the
 * point: if the events had been published from call sites instead, this file could not have been
 * written at all.
 *
 * ⚠️ **The store double is `MemoryClient.stub()`, deliberately not a hand-rolled fake.** The stub is
 * the repo's fidelity-checked in-memory client, so a claim that would be REFUSED (out-of-scope
 * write) or DEDUPED here is refused or deduped the way the engine does it — and the "a refusal
 * announces nothing" case below is therefore about real refusal behaviour rather than about a
 * `false` somebody typed.
 *
 * ⚠️ **Absence is always paired with presence in the same run.** "No event for a refused write"
 * passes trivially on a wrapper that publishes nothing at all, which is precisely the regression
 * this file is here to catch.
 */

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]))
const it = testEffect(layer)

const SCOPE = "session:ses_observed"
const access = MemoryAccess.of([SCOPE])

/**
 * Build the observed store the way the instance does: the bus and the ledger handed in ONCE.
 *
 * ⚠️ They used to be read per call with `serviceOption`, and this file passed either way — which is
 * exactly why it could not see that the `kb` tool's environment has no `EventV2` in it and every
 * event in the product was a silent no-op. Constructing it the way `memory.ts` does is what keeps
 * this file honest about the shape being shipped.
 */
const observing = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const ledger = (yield* Database.Service).db
  return MemoryObserved.observed(MemoryClient.stub(), { events, ledger })
})

/**
 * Collect the memory events published while `body` runs.
 *
 * ⚠️ **`listen`, not a stream take.** A `Stream.take(n)` collector cannot distinguish "no events"
 * from "not yet", so the A/B for this file — neuter the wrapper, watch these tests go red — WEDGED
 * instead of failing. `listen` runs its listener inside `publish`, so when the body returns every
 * event it caused has already been recorded and the assertion is about a settled array. A test whose
 * negative case hangs is a test you cannot A/B, which is the same as a test you cannot trust.
 */
const watching = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const seen: { type: string; data: unknown }[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type.startsWith("memory.")) seen.push({ type: event.type, data: event.data })
      }),
    )
    const result = yield* body.pipe(Effect.ensuring(unsubscribe))
    return { result, seen }
  })

describe("the observed memory store", () => {
  it.effect("a claim, its correction and the retirement it causes all reach the bus", () =>
    Effect.gen(function* () {
      const store = yield* observing
      const { result, seen } = yield* watching(
        Effect.gen(function* () {
          yield* store.addClaim(
            { scope: SCOPE, statement: "Ann works at Initech", subject: "Ann", predicate: "employer" },
            access,
          )
          return yield* store.addClaim(
            { scope: SCOPE, statement: "Ann works at Acme", subject: "Ann", predicate: "employer" },
            access,
          )
        }),
      )

      // The store really did correct — otherwise the "superseded" assertion below is about nothing.
      expect(result.ok).toBe(true)
      expect(result.superseded.length).toBe(1)

      expect(seen.map((event) => event.type)).toEqual(["memory.claim.recorded", "memory.claim.recorded"])
      const first = seen[0]!.data as { statement: string; superseded: readonly string[]; identified: boolean }
      const second = seen[1]!.data as { statement: string; superseded: readonly string[] }
      expect(first.superseded).toEqual([])
      expect(first.identified).toBe(true)
      expect(second.statement).toBe("Ann works at Acme")
      // What visibly RETIRES in the overlay, carried on the same event as what replaced it.
      expect(second.superseded).toEqual(result.superseded as string[])
    }),
  )

  it.effect("a recall announces its hits in rank order, with a fingerprint and never the query", () =>
    Effect.gen(function* () {
      const store = yield* observing
      const { seen } = yield* watching(
        Effect.gen(function* () {
          yield* store.addMemory({ id: "mem_a", kind: "episode", text: "the harbour at dawn", scope: SCOPE })
          yield* store.addMemory({ id: "mem_b", kind: "episode", text: "the harbour at dusk", scope: SCOPE })
          return yield* store.search({ query: "Harbour At", scopes: [SCOPE], surface: "auto-recall" })
        }),
      )

      expect(seen.map((event) => event.type)).toEqual([
        "memory.item.recorded",
        "memory.item.recorded",
        "memory.recalled",
      ])
      const recall = seen[2]!.data as {
        fingerprint: string
        surface: string
        hits: ReadonlyArray<{ id: string; rank: number }>
        considered: number
      }
      expect(recall.surface).toBe("auto-recall")
      expect(recall.considered).toBe(2)
      expect(recall.hits.map((hit) => hit.rank)).toEqual([1, 2])
      // The fingerprint folds case and whitespace, so the same question asked twice — however it
      // was typed — is one question to the overlay and to the P3 ledger.
      expect(recall.fingerprint).toBe(MemoryObserved.fingerprint("  HARBOUR   at "))
      // ABSENCE, paired with the presences above: the words the user typed are not on the bus.
      expect(JSON.stringify(seen[2]!.data)).not.toContain("Harbour")
    }),
  )

  it.effect("a write the store REFUSES announces nothing, while the accepted one beside it does", () =>
    Effect.gen(function* () {
      const store = yield* observing
      const { result, seen } = yield* watching(
        Effect.gen(function* () {
          // Out of this caller's reach: the lifecycle refuses it rather than retiring a stranger's
          // current answer. Nothing changed, so nothing may be announced.
          const refused = yield* store.addClaim(
            { scope: "session:somebody_else", statement: "Ann works at Acme", subject: "Ann", predicate: "employer" },
            access,
          )
          yield* store.addMemory({ id: "mem_ok", kind: "episode", text: "an accepted write", scope: SCOPE })
          return refused
        }),
      )

      expect(result.ok).toBe(false)
      expect(result.reason).toBe("refused-scope")
      // PRESENCE — the bus was live and did carry the write that succeeded …
      expect(seen.map((event) => event.type)).toEqual(["memory.item.recorded"])
      // … and ABSENCE — no claim event for the refusal.
      expect(seen.some((event) => event.type === "memory.claim.recorded")).toBe(false)
    }),
  )

  it.effect("reading the store the way the Memory app does publishes nothing", () =>
    Effect.gen(function* () {
      const store = yield* observing
      const { seen } = yield* watching(
        Effect.gen(function* () {
          yield* store.list({ scopes: [SCOPE] })
          yield* store.graph({ scopes: [SCOPE] })
          yield* store.stats()
          // The sentinel: a write AFTER the viewer's reads. It is what proves the collector was
          // armed and listening the whole time, so the four reads' silence is real silence.
          yield* store.addMemory({ id: "mem_sentinel", kind: "episode", text: "sentinel", scope: SCOPE })
        }),
      )
      expect(seen.map((event) => event.type)).toEqual(["memory.item.recorded"])
    }),
  )

  it.effect("with no ledger the store still works, and still announces itself", () =>
    Effect.gen(function* () {
      // Environments without a database are real: a bare engine harness, the absorb evaluator. What
      // changed is that `ledger: undefined` is now something a caller has to TYPE, so the state
      // cannot be arrived at by forgetting — which is the failure mode that made every event in the
      // product a silent no-op. The bus stays required, because there is no environment in which
      // losing it quietly is the right answer.
      const events = yield* EventV2.Service
      const store = MemoryObserved.observed(MemoryClient.stub(), { events, ledger: undefined })
      const { result, seen } = yield* watching(
        store.addClaim({ scope: SCOPE, statement: "still works", subject: "it", predicate: "status" }, access),
      )
      expect(result.ok).toBe(true)
      expect(seen.map((event) => event.type)).toEqual(["memory.claim.recorded"])
    }),
  )
})
