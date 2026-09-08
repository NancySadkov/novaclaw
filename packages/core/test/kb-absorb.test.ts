import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { KbAbsorb } from "@novaclaw/core/kb-graph/absorb"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import { LLMEvent, Model } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"

/** A real resolved route: LLM.request VALIDATES the model, so a stub object is rejected. */
const MODEL = Model.make({ id: "absorb-test", provider: "harness", route: OpenAIChat.route })

/**
 * 🔴 `ingest` chunked a document and stopped: 303 nodes carrying ONE distinct name, so a monster
 * manual had no `Siege Crab` node and never would. Structure came first (every passage hung off a
 * document entity); this is the half that reads what a passage SAYS.
 */
/**
 * ⚠️ Built with the REAL event constructors, not hand-rolled objects. A literal
 * `{ type: "text-delta", text }` is missing the required `id` and silently fails
 * `LLMEvent.is.textDelta`, so every collector sees nothing — which made three of these tests pass
 * against an EMPTY extraction while asserting `[]` was the right answer.
 */
const llmYielding = (text: string, onRequest?: (req: unknown) => void) =>
  ({
    stream: (request: unknown) => {
      onRequest?.(request)
      return Stream.fromIterable([LLMEvent.textDelta({ id: "text-0", text }), LLMEvent.finish({ reason: "stop" })])
    },
  }) as never

const recordingMemory = () => {
  const memories: Array<Record<string, unknown>> = []
  const edges: Array<Record<string, unknown>> = []
  return {
    memories,
    edges,
    client: {
      addMemory: (m: Record<string, unknown>) => Effect.sync(() => void memories.push(m)),
      addEdge: (e: Record<string, unknown>) => Effect.sync(() => void edges.push(e)),
    } as never,
  }
}

describe("KbAbsorb.extractPassage", () => {
  test("parses named things out of a passage", async () => {
    const facts = await Effect.runPromise(
      KbAbsorb.extractPassage({
        llm: llmYielding('[{"name":"Siege Crab","text":"A Siege Crab has Armor Class 18."}]'),
        model: MODEL,
        text: "The siege crab is a huge crustacean...",
      }),
    )
    expect(facts).toEqual([{ name: "Siege Crab", text: "A Siege Crab has Armor Class 18." }])
  })

  test("a nameless fact is DROPPED — an entity keyed on nothing is unreachable", async () => {
    // The graph is keyed by name. A fact with no name cannot become a node anyone can find again,
    // and storing it anyway is how the store fills with things that answer no question.
    const facts = await Effect.runPromise(
      KbAbsorb.extractPassage({
        llm: llmYielding('[{"text":"Something happens."},{"name":"Baldur\'s Gate","text":"A city."}]'),
        model: MODEL,
        text: "...",
      }),
    )
    expect(facts.map((f) => f.name)).toEqual(["Baldur's Gate"])
  })

  test("page furniture yields nothing, and that is an ANSWER not a failure", async () => {
    expect(
      await Effect.runPromise(
        KbAbsorb.extractPassage({ llm: llmYielding("[]"), model: MODEL, text: "Table of Contents" }),
      ),
    ).toEqual([])
  })

  test("thinking is ALLOWED within a budget, not suppressed outright", () => {
    // Owner ruling 2026-08-12: memory organisation runs off the reply path with a limited context
    // budget, and thinking is disabled only if the model FAILS within it — the shape session-title
    // generation already ships. This pass previously sent `enable_thinking:false` on every call.
    //
    // Measured on qwen3.6-35b with thinking off: it named "Special Attacks and Special Qualities" (a
    // section heading) and "creature's primary attack damage" (a description), both of which the
    // prompt forbids. Buying a guaranteed answer with a cheap one is exactly what running off the
    // reply path exists to avoid.
    let seen: { system?: ReadonlyArray<{ text?: string }>; http?: { body?: unknown } } | undefined
    return Effect.runPromise(
      KbAbsorb.extractPassage({
        llm: llmYielding("[]", (req) => void (seen = req as never)),
        model: MODEL,
        text: "x",
      }),
    ).then(() => {
      // No unconditional suppression: `ReasoningBudget` owns the fallback, and it re-issues the turn
      // with thinking disabled only after the budget is spent.
      expect(seen?.http?.body).toBeUndefined()
      // The budget announces itself in the system prompt — that is how the nudges are delivered.
      expect(JSON.stringify(seen?.system ?? [])).toContain(String(KbAbsorb.ABSORB_REASONING_BUDGET))
    })
  })
})

describe("KbAbsorb.writeAbsorbed", () => {
  test("an entity uses the SHARED id, so a rulebook and a chat land on one node", async () => {
    const mem = recordingMemory()
    await Effect.runPromise(
      KbAbsorb.writeAbsorbed({
        memory: mem.client,
        scope: "global",
        passageID: "mem_p123",
        facts: [{ name: "Siege Crab", text: "A Siege Crab has Armor Class 18." }],
      }),
    )
    // Literally the same function the conversational path uses — two formulas would mint two nodes
    // for one name, which is the fragmentation this program removed.
    expect(mem.memories[0]!.id).toBe(KbChunk.entityID("global", "Siege Crab"))
    expect(mem.memories[0]!.kind).toBe("entity")
  })

  test("the edge runs passage -> entity, and only AFTER the node exists", async () => {
    const mem = recordingMemory()
    const order: string[] = []
    const client = {
      addMemory: (m: Record<string, unknown>) => Effect.sync(() => void order.push(`node:${String(m.id)}`)),
      addEdge: (e: Record<string, unknown>) => Effect.sync(() => void order.push(`edge:${String(e.to)}`)),
    } as never
    await Effect.runPromise(
      KbAbsorb.writeAbsorbed({
        memory: client,
        scope: "global",
        passageID: "mem_p123",
        facts: [{ name: "Siege Crab", text: "..." }],
      }),
    )
    const id = KbChunk.entityID("global", "Siege Crab")
    // A reversed or early edge still "connects" — which is why order and direction are both pinned.
    expect(order).toEqual([`node:${id}`, `edge:${id}`])
    void mem
  })
})

describe("KbAbsorb.absorb", () => {
  test("🔴 honours `limit` — every passage is a model call, and a document is hundreds", async () => {
    let calls = 0
    const mem = recordingMemory()
    const result = await Effect.runPromise(
      KbAbsorb.absorb({
        llm: llmYielding('[{"name":"Thing","text":"A fact."}]', () => void calls++),
        model: MODEL,
        memory: mem.client,
        scope: "global",
        passages: Array.from({ length: 50 }, (_, i) => ({ id: `mem_p${i}`, text: `passage ${i}` })),
        limit: 3,
      }),
    )
    expect(calls).toBe(3)
    expect(result).toEqual({ passages: 3, entities: 3 })
  })

  test("a limit of 0 spends nothing (negative control)", async () => {
    let calls = 0
    const mem = recordingMemory()
    const result = await Effect.runPromise(
      KbAbsorb.absorb({
        llm: llmYielding("[]", () => void calls++),
        model: MODEL,
        memory: mem.client,
        scope: "global",
        passages: [{ id: "mem_p0", text: "x" }],
        limit: 0,
      }),
    )
    expect(calls).toBe(0)
    expect(result.passages).toBe(0)
  })

  test("one bad passage does not abandon the rest", async () => {
    // It runs detached from the request that started it, so nobody is watching to retry. Losing a
    // whole document to a single bad chunk is the failure this catch exists for.
    let n = 0
    const mem = recordingMemory()
    const llm = {
      stream: () => {
        n++
        if (n === 2) return Stream.fail(new Error("model exploded")) as never
        return Stream.fromIterable([
          LLMEvent.textDelta({ id: "text-0", text: '[{"name":"Thing","text":"A fact."}]' }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    } as never
    const result = await Effect.runPromise(
      KbAbsorb.absorb({
        llm,
        model: MODEL,
        memory: mem.client,
        scope: "global",
        passages: [
          { id: "a", text: "1" },
          { id: "b", text: "2" },
          { id: "c", text: "3" },
        ],
        limit: 3,
      }),
    )
    expect(result.passages).toBe(3)
    expect(result.entities).toBe(2)
  })
})
