import { describe, expect, test } from "bun:test"
import { CompactionPrune } from "@novaclaw/core/session/compaction-prune"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import { applySteerProvenance } from "@novaclaw/core/session/steer-provenance"
import type { Config } from "@novaclaw/core/config"
import type { EventV2 } from "@novaclaw/core/event"
import type { SessionMessage } from "@novaclaw/core/session/message"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import { LLM, LLMEvent, Model, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { DateTime, Effect, Stream } from "effect"

// A2-a — `prune()`, the non-LLM reclaim lost in the V1 nuke (todo/adoption.md §A2).
//
// Every clause of the spec is asserted here against the PURE module, because the thresholds are the
// feature: "protect the newest 40k tokens of tool output and the last 2 turns, exempt `skill`
// output, erase older tool results, commit only if the reclaim clears 20k". A prune that erases
// history it should have protected is unrecoverable from inside a session, so the protections get
// negative controls (a fixture that WOULD be erased if the clause were absent), not just a
// happy-path check.

const AT = DateTime.makeUnsafe(1_700_000_000_000)

/** ~4 chars/token (util/token.ts), so a tool result of N tokens needs ~4N chars of output. */
const chars = (tokens: number) => "o".repeat(tokens * 4)

let nextID = 0
const id = (prefix: string) => `${prefix}_${(nextID++).toString().padStart(4, "0")}`

const tool = (input: {
  readonly tokens: number
  readonly name?: string
  readonly pruned?: boolean
  readonly status?: "completed" | "running"
}): SessionMessage.AssistantTool =>
  ({
    type: "tool",
    id: id("call"),
    name: input.name ?? "read",
    provider: { executed: false },
    state: {
      status: input.status ?? "completed",
      input: { filePath: "/repo/src/thing.ts" },
      content: [{ type: "text", text: chars(input.tokens) }],
      structured: {},
    },
    time: { created: AT, completed: AT, ...(input.pruned === true ? { pruned: AT } : {}) },
  }) as unknown as SessionMessage.AssistantTool

const assistant = (text: string, tools: SessionMessage.AssistantTool[] = []): SessionMessage.Assistant =>
  ({
    type: "assistant",
    id: id("msg"),
    agent: "build",
    model: { providerID: "dgx-spark", id: "qwen3.6-35b" },
    content: [{ type: "text", id: id("txt"), text }, ...tools],
    time: { created: AT, completed: AT },
  }) as unknown as SessionMessage.Assistant

const user = (text: string): SessionMessage.Message =>
  ({ type: "user", id: id("msg"), text, time: { created: AT } }) as unknown as SessionMessage.Message

const steer = (text: string) => user(applySteerProvenance(text))

const compaction = (): SessionMessage.Message =>
  ({
    type: "compaction",
    id: id("msg"),
    reason: "auto",
    summary: "## Goal\n- earlier work",
    recent: "earlier tail",
    time: { created: AT },
  }) as unknown as SessionMessage.Message

const toolsOf = (message: SessionMessage.Message): SessionMessage.AssistantTool[] =>
  message.type === "assistant"
    ? message.content.filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
    : []

const targeted = (plan: CompactionPrune.Plan) => plan.targets.map((target) => target.callID)

/**
 * The canonical fixture: six ~12k-token `read` results in one OLD assistant message, then two more
 * turns. Walking back, the newest three fit inside the 40k protection and the older three do not.
 */
const transcript = (input: { readonly old: SessionMessage.AssistantTool[]; readonly recentTokens?: number }) => {
  const older = assistant("earlier work", input.old)
  const recent = assistant("recent work", [tool({ tokens: input.recentTokens ?? 1 })])
  return {
    older,
    recent,
    messages: [user("start the task"), older, user("keep going"), recent, user("now do this")],
  }
}

const sixReads = () => [
  tool({ tokens: 12_000 }),
  tool({ tokens: 12_000 }),
  tool({ tokens: 12_000 }),
  tool({ tokens: 12_000 }),
  tool({ tokens: 12_000 }),
  tool({ tokens: 12_000 }),
]

describe("the thresholds are the real numbers the spec names", () => {
  test("40k protected, 2 turns protected, 20k minimum reclaim, skill exempt", () => {
    expect(CompactionPrune.PROTECT_TOOL_OUTPUT_TOKENS).toBe(40_000)
    expect(CompactionPrune.PROTECT_RECENT_TURNS).toBe(2)
    expect(CompactionPrune.MIN_RECLAIM_TOKENS).toBe(20_000)
    expect(CompactionPrune.EXEMPT_TOOLS).toEqual(["skill"])
  })

  test("outputTokens estimates what lowering actually sends, not the row", () => {
    // `{structured, content}` for a local tool (runner/to-llm-message.ts `toolResult`).
    const local = tool({ tokens: 12_000 })
    expect(CompactionPrune.outputTokens(local)).toBeGreaterThan(11_900)
    expect(CompactionPrune.outputTokens(local)).toBeLessThan(12_100)
    // A part that has not settled costs nothing to erase, so it is never counted.
    expect(CompactionPrune.outputTokens(tool({ tokens: 12_000, status: "running" }))).toBe(0)
  })
})

describe("prune protects the newest 40k tokens of tool output", () => {
  test("the newest results inside the ceiling survive; the older ones are targeted", () => {
    const old = sixReads()
    const plan = CompactionPrune.plan(transcript({ old }).messages)
    // Walked newest-first: [5],[4],[3] total ~36k and stay; [2] crosses 40k and goes with [1],[0].
    expect(targeted(plan)).toEqual([old[2]!.id, old[1]!.id, old[0]!.id])
    expect(plan.reclaim).toBeGreaterThan(35_000)
    expect(plan.scanned).toBeGreaterThan(70_000)
    expect(plan.commit).toBe(true)
    // Negative control on the protection: the three newest are not merely last in the list.
    for (const survivor of [old[5]!, old[4]!, old[3]!]) expect(targeted(plan)).not.toContain(survivor.id)
  })

  test("tool output entirely under the ceiling is never touched, however many calls", () => {
    const old = [tool({ tokens: 9_000 }), tool({ tokens: 9_000 }), tool({ tokens: 9_000 }), tool({ tokens: 9_000 })]
    const plan = CompactionPrune.plan(transcript({ old }).messages)
    expect(plan.targets).toEqual([])
    expect(plan.reclaim).toBe(0)
    expect(plan.commit).toBe(false)
  })
})

describe("prune protects the last 2 turns", () => {
  test("a huge result inside the newest two turns is never targeted, nor counted", () => {
    // 200k tokens of tool output in the most recent turn — every clause except this one would
    // erase it, and it is also enough to blow the 40k ceiling on its own.
    const { messages, recent } = transcript({ old: [tool({ tokens: 5_000 })], recentTokens: 200_000 })
    const plan = CompactionPrune.plan(messages)
    expect(targeted(plan)).not.toContain(toolsOf(recent)[0]!.id)
    expect(plan.commit).toBe(false)
    // Not counted either: the protected turn did not consume the 40k budget on behalf of the older
    // result, which is still comfortably inside it.
    expect(plan.scanned).toBeLessThan(6_000)
  })

  test("a harness steer is not a turn — it cannot shrink the protected window", () => {
    const old = sixReads()
    const { older, recent } = transcript({ old })
    // Two steers between the last two real user turns: if a steer counted as a turn, the walk
    // would reach `turns >= 2` early and `recent`'s output would become eligible.
    const messages = [
      user("start the task"),
      older,
      user("keep going"),
      recent,
      steer("You have called `bash` with identical arguments 3 times in a row."),
      steer("Stop deliberating and act."),
      user("now do this"),
    ]
    const plan = CompactionPrune.plan(messages)
    expect(targeted(plan)).not.toContain(toolsOf(recent)[0]!.id)
    expect(targeted(plan)).toEqual([old[2]!.id, old[1]!.id, old[0]!.id])
  })
})

describe("prune exempts skill output", () => {
  test("a huge skill result is neither erased nor charged against the 40k ceiling", () => {
    const skill = tool({ tokens: 200_000, name: "skill" })
    const old = sixReads()
    // The skill result is the NEWEST part of the old message, so without the exemption it alone
    // exceeds the ceiling and every `read` behind it would be erased.
    const plan = CompactionPrune.plan(transcript({ old: [...old, skill] }).messages)
    expect(targeted(plan)).not.toContain(skill.id)
    expect(targeted(plan)).toEqual([old[2]!.id, old[1]!.id, old[0]!.id])
    expect(plan.scanned).toBeLessThan(80_000)
    // And the erase leaves the skill part byte-identical (same object).
    const messages = transcript({ old: [...old, skill] }).messages
    const erased = CompactionPrune.erase(messages, CompactionPrune.plan(messages), AT)
    const survivor = toolsOf(erased[1]!).find((part) => part.name === "skill")
    expect(survivor?.state.status === "completed" && survivor.state.content[0]).toEqual({
      type: "text",
      text: chars(200_000),
    })
  })
})

describe("prune erases older tool results, and only the output", () => {
  const setup = () => {
    const old = sixReads()
    const messages = transcript({ old }).messages
    const plan = CompactionPrune.plan(messages)
    return { old, messages, plan, erased: CompactionPrune.erase(messages, plan, AT) }
  }

  test("the targeted result becomes the notice, stamped with time.pruned", () => {
    const { old, erased } = setup()
    const part = toolsOf(erased[1]!).find((item) => item.id === old[0]!.id)!
    expect(part.state.status).toBe("completed")
    expect(part.state.status === "completed" && part.state.content).toEqual([
      { type: "text", text: CompactionPrune.ERASED_NOTICE },
    ])
    expect(part.state.status === "completed" && part.state.structured).toEqual({})
    expect(part.state.status === "completed" && part.state.result).toBeUndefined()
    expect(part.time.pruned).toEqual(AT)
    expect(CompactionPrune.isPruned(part)).toBe(true)
    // The CALL and its arguments survive — the model must still see what it asked for.
    expect(part.name).toBe("read")
    expect(part.state.status === "completed" && part.state.input).toEqual({ filePath: "/repo/src/thing.ts" })
  })

  test("untargeted parts and unrelated messages come back by identity", () => {
    const { old, messages, erased } = setup()
    for (const survivor of [old[5]!, old[4]!, old[3]!])
      expect(toolsOf(erased[1]!).find((part) => part.id === survivor.id)).toBe(survivor)
    // Only the assistant message that owned a target is rebuilt; every other message is the same
    // object, so nothing else in the transcript can drift through a prune.
    for (const index of [0, 2, 3, 4]) expect(erased[index]).toBe(messages[index])
  })

  test("the reclaim is real: the erased transcript estimates far smaller", () => {
    const { erased, plan } = setup()
    const before = CompactionPrune.plan(transcript({ old: sixReads() }).messages)
    expect(plan.reclaim).toBe(before.reclaim)
    const size = (messages: readonly SessionMessage.Message[]) => JSON.stringify(messages).length
    expect(size(erased)).toBeLessThan(size(setup().messages) - plan.reclaim * 3)
  })

  test("a second prune finds nothing — the walk stops at the first already-pruned result", () => {
    const { erased } = setup()
    const again = CompactionPrune.plan(erased)
    expect(again.targets).toEqual([])
    expect(again.commit).toBe(false)
    expect(CompactionPrune.erase(erased, again, AT)).toBe(erased)
  })

  test("the walk stops at a compaction message — pre-checkpoint history is not re-pruned", () => {
    const old = sixReads()
    const older = assistant("earlier work", old)
    const messages = [
      user("start the task"),
      older,
      compaction(),
      user("keep going"),
      assistant("recent work", [tool({ tokens: 1 })]),
      user("now do this"),
    ]
    const plan = CompactionPrune.plan(messages)
    expect(plan.targets).toEqual([])
    expect(plan.scanned).toBe(0)
  })
})

describe("prune commits only if the reclaim clears 20k", () => {
  test("under the floor: no commit, and history is the SAME array", () => {
    // Four ~12k results: three fit in the 40k protection, so only ~12k is reclaimable.
    const old = [tool({ tokens: 12_000 }), tool({ tokens: 12_000 }), tool({ tokens: 12_000 }), tool({ tokens: 12_000 })]
    const messages = transcript({ old }).messages
    const plan = CompactionPrune.plan(messages)
    expect(plan.targets).toHaveLength(1)
    expect(plan.reclaim).toBeGreaterThan(11_000)
    expect(plan.reclaim).toBeLessThan(CompactionPrune.MIN_RECLAIM_TOKENS)
    expect(plan.commit).toBe(false)
    // The whole point of the floor: nothing is rewritten. Identity, not deep equality.
    expect(CompactionPrune.erase(messages, plan, AT)).toBe(messages)
  })

  test("just over the floor: it commits", () => {
    const old = [
      tool({ tokens: 12_000 }),
      tool({ tokens: 11_000 }),
      tool({ tokens: 12_000 }),
      tool({ tokens: 12_000 }),
      tool({ tokens: 12_000 }),
    ]
    const messages = transcript({ old }).messages
    const plan = CompactionPrune.plan(messages)
    expect(plan.reclaim).toBeGreaterThan(CompactionPrune.MIN_RECLAIM_TOKENS)
    expect(plan.commit).toBe(true)
    expect(CompactionPrune.erase(messages, plan, AT)).not.toBe(messages)
  })

  test("an empty or tool-free transcript is a no-op, not a crash", () => {
    for (const messages of [[], [user("hi")], [user("hi"), assistant("hello"), user("again")]]) {
      const plan = CompactionPrune.plan(messages)
      expect(plan).toEqual({ commit: false, targets: [], reclaim: 0, scanned: 0 })
      expect(CompactionPrune.erase(messages, plan, AT)).toBe(messages)
    }
  })
})

// ── The config flag: declared on ConfigV2.Compaction since before this tier existed, and read by
// NOTHING until now. `settings()` folded `auto`/`buffer`/`tokens` and silently dropped `prune` —
// a missing key in a reduce compiles green, which is exactly the defect class ruling 1 names.
describe("the prune flag is honoured, and absent means inert", () => {
  const document = (compaction: Record<string, unknown>) =>
    ({ type: "document", info: { compaction } }) as unknown as Config.Entry

  test("absent: prune is off, so an unconfigured instance behaves exactly as before", () => {
    expect(SessionCompaction.settings([]).prune).toBe(false)
    expect(SessionCompaction.settings([document({ auto: true })]).prune).toBe(false)
  })

  test("explicit false is off; explicit true is on", () => {
    expect(SessionCompaction.settings([document({ prune: false })]).prune).toBe(false)
    expect(SessionCompaction.settings([document({ prune: true })]).prune).toBe(true)
  })

  test("later documents win, per key, without clobbering the other keys", () => {
    const folded = SessionCompaction.settings([
      document({ prune: true, buffer: 1_000, auto: false }),
      document({ prune: false }),
    ])
    expect(folded).toEqual({ auto: false, buffer: 1_000, tokens: 8_000, prune: false })
  })

  test("the other keys still fold — the reduce was not broken by adding prune", () => {
    expect(SessionCompaction.settings([])).toEqual({ auto: true, buffer: 20_000, tokens: 8_000, prune: false })
    expect(SessionCompaction.settings([document({ keep: { tokens: 2_000 } })]).tokens).toBe(2_000)
  })
})

// ── The tier is LIVE, not a pure module nobody calls. `compactAfterOverflow` is the one prune site
// (`compactIfNeeded` and the manual `/compact` cycle both enter through it), so this drives the real
// factory with a canned summarizer and asserts on the prompt it actually sent.
describe("the cheap tier runs inside compactAfterOverflow, ahead of the summarizer", () => {
  const model = Model.make({
    id: "qwen3.6-35b",
    provider: "dgx-spark",
    route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
  })

  const drive = (input: { readonly prune: boolean; readonly messages: readonly SessionMessage.Message[] }) => {
    const published: { readonly type: string; readonly data: Record<string, unknown> }[] = []
    const requests: LLMRequest[] = []
    const compactor = SessionCompaction.make({
      events: {
        publish: (definition: { type: string }, data: Record<string, unknown>) =>
          Effect.sync(() => {
            published.push({ type: definition.type, data })
          }),
      } as unknown as EventV2.Interface,
      llm: {
        stream: (request: LLMRequest) => {
          requests.push(request)
          return Stream.fromIterable([LLMEvent.textDelta({ id: "text-0", text: "## Goal\n- keep going" })])
        },
      } as never,
      // `keep.tokens` is small so the transcript lands in the summarized HEAD rather than the
      // verbatim tail — the head is what carries the tool results this tier erases.
      config: [
        {
          type: "document",
          info: { compaction: { keep: { tokens: 100 }, ...(input.prune ? { prune: true } : {}) } },
        } as unknown as Config.Entry,
      ],
      prefixHash: () => Effect.succeed("0".repeat(64)),
    })
    const compacted = Effect.runSync(
      compactor.compactAfterOverflow(
        {
          sessionID: "ses_prune_test" as unknown as SessionSchema.ID,
          entries: input.messages.map((message, seq) => ({ seq, message })),
          model,
          request: LLM.request({ model, messages: [], tools: [] }),
        },
        "manual",
      ),
    )
    const prompt = requests[0]?.messages
      .flatMap((message) => message.content.map((part) => ("text" in part ? part.text : "")))
      .join("\n")
    return { compacted, published, prompt: prompt ?? "" }
  }

  test("with prune on, the summary prompt carries the notice instead of the stale output", () => {
    const messages = transcript({ old: sixReads() }).messages
    const off = drive({ prune: false, messages })
    const on = drive({ prune: true, messages })

    expect(off.compacted).toBe(true)
    expect(on.compacted).toBe(true)
    for (const run of [off, on]) {
      expect(run.published.map((event) => event.type)).toEqual([
        "session.next.compaction.started",
        "session.next.compaction.ended",
      ])
    }
    // Three of the six results are older than the 40k protection, so the notice appears at least
    // three times. NOT an exact count: `selectContext` puts the message that STRADDLES the
    // head/recent boundary into `head` twice — whole, and again as its truncated prefix (`split =
    // index + 1` at compaction.ts's split loop). That is a pre-existing token-waste defect in the
    // summarize tier, unrelated to prune and deliberately not fixed here; asserting `=== 3` would
    // pin the bug instead of the feature.
    expect(on.prompt.split(CompactionPrune.ERASED_NOTICE).length - 1).toBeGreaterThanOrEqual(3)
    expect(off.prompt).not.toContain(CompactionPrune.ERASED_NOTICE)
    // ...and the prompt shrinks by the truncated bodies they replaced (TOOL_OUTPUT_MAX_CHARS each).
    expect(off.prompt.length - on.prompt.length).toBeGreaterThan(5_000)
  })

  test("prune never blocks or alters the summarize tier when it does not commit", () => {
    // Under the 20k floor: byte-identical prompt with the flag on and off.
    const messages = transcript({ old: [tool({ tokens: 12_000 }), tool({ tokens: 12_000 })] }).messages
    const off = drive({ prune: false, messages })
    const on = drive({ prune: true, messages })
    expect(on.compacted).toBe(true)
    expect(on.prompt).toBe(off.prompt)
    expect(on.prompt).not.toContain(CompactionPrune.ERASED_NOTICE)
  })
})
