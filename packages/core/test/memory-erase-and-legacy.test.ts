import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

/**
 * ERASING EVERYTHING, AND DISCARDING THE PRE-ROSTER LEAK.
 *
 * 🔴 Two operations that both delete, with deliberately different reach — and the difference is the
 * whole point, so it is asserted rather than described. `discardLegacyGlobalExtracts` must take ONLY
 * the leaked set; `eraseAll` must take EVERYTHING, including the governing agent's cabinet, or a
 * tabula-rasa run stands on somebody's leftovers.
 *
 * ⚠️ Driven through `MemoryClient.stub()`, which is the shape every caller sees. The engine's own
 * Cypher is exercised by the WASM smoke (`kb-graph-forgetting.smoke.ts`); this pins the CONTRACT, and
 * the stub had to grow both methods to satisfy the interface — which is how the type system made sure
 * no implementation was left behind.
 */

const remember = (memory: MemoryClient.Interface, id: string, scope: string, source: string) =>
  memory.addMemory({ id, kind: "entity", text: `fact ${id}`, scope, source } as never)

const seed = Effect.fn(function* () {
  const memory = MemoryClient.stub()
  yield* remember(memory, "m_nova", "agent:nova", "remember")
  yield* remember(memory, "m_theron", "agent:theron", "remember")
  yield* remember(memory, "m_leaked", "global", "auto-extract")
  yield* remember(memory, "m_leaked2", "global", "auto-extract")
  yield* remember(memory, "m_household", "global", "remember")
  yield* remember(memory, "m_chat", "session:ses_1", "auto-extract")
  return memory
})

const scopes = ["agent:nova", "agent:theron", "global", "session:ses_1"]
const remaining = (memory: MemoryClient.Interface) =>
  memory.list({ scopes, includeInvalid: false }).pipe(Effect.map((rows) => rows.map((row) => row.id).sort()))

describe("discarding the pre-roster leak", () => {
  test("takes the leaked rows and NOTHING else", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* seed()
        const discarded = yield* memory.discardLegacyGlobalExtracts()
        return { discarded, left: yield* remaining(memory) }
      }),
    )
    expect(outcome.discarded).toBe(2)
    // 🔴 The household's DELIBERATE global facts survive: `remember` scoped global is a choice the
    // user made, not the leak. So does a chat-scoped extraction, which never leaked anywhere.
    expect(outcome.left).toEqual(["m_chat", "m_household", "m_nova", "m_theron"])
  })

  test("is idempotent — a second pass finds nothing", async () => {
    const twice = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* seed()
        yield* memory.discardLegacyGlobalExtracts()
        return yield* memory.discardLegacyGlobalExtracts()
      }),
    )
    // No marker, no flag: the predicate simply matches nothing once it has run, and nothing writes
    // rows that match it again.
    expect(twice).toBe(0)
  })
})

describe("erasing everything", () => {
  test("takes every scope, INCLUDING the governing agent's", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* seed()
        const erased = yield* memory.eraseAll()
        return { erased, left: yield* remaining(memory) }
      }),
    )
    expect(outcome.erased).toBe(6)
    // 🔴 Nova included. The charter protects Nova's IDENTITY — its profile is fixed in code — not its
    // filing cabinet, and an "everything except Nova" arm would defeat what this is for.
    expect(outcome.left).toEqual([])
  })

  test("an already-empty store reports 0 rather than implying something happened", async () => {
    const erased = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = MemoryClient.stub()
        return yield* memory.eraseAll()
      }),
    )
    expect(erased).toBe(0)
  })
})
