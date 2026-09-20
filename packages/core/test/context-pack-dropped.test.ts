/**
 * Deterministic compaction has to leave a trail (`invariants.md`, Context Management 2).
 *
 * Clause 2 asks for three things in one sentence, and each of them is a separate way to be wrong:
 *
 *   1. "take the original context ... chop away its head" — the packer knows WHAT it cut, and a count
 *      is not text;
 *   2. "prefix result with the system prompt and a `<.../tmp/oldctx-<DATETIME>.txt holds earlier
 *      chat>` tombstone" — the line has to ride the request that actually leaves;
 *   3. "so that agent can still grep it" — the promise is only true if the file is written, so a line
 *      that names an unwritten file is the defect, not the fix.
 *
 * The three are ordered, and the order is what these tests pin: reserve the line's room BEFORE the
 * packer measures (a line added after the measurement is an unmeasured line — the exact shape of the
 * paid-for `OVERSIZED_MARKER_TOKENS` defect, 20,093 against 20,000), emit it only when something
 * really left, and hand the caller the text so it can write the file the line names.
 */
import { describe, expect, test } from "bun:test"
import { ProviderDispatch } from "@novaclaw/core/session/runner/provider-dispatch"
import { pack, packRequest } from "@novaclaw/core/session/runner/context-pack"
import { OldContext } from "@novaclaw/core/session/old-context"
import { LLM, Message, Model, SystemPart } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"

const routed = (limits: { context: number; output: number }) =>
  Model.make({ id: "dropped-test", provider: "test", route: OpenAIChat.route.with({ limits }) })

const model = routed({ context: 12_000, output: 4_096 })

/** Two messages that cannot both fit a small window, plus the newest one that always stays. */
const oversized = [
  Message.user(`old request ${"gamma ".repeat(6_000)}`),
  Message.assistant(`old answer ${"delta ".repeat(6_000)}`),
  Message.user("continue safely"),
]

const request = (messages: ReadonlyArray<Message>, system?: string) =>
  LLM.request({ model, messages: [...messages], tools: [], ...(system === undefined ? {} : { system }) })

const droppedFile = "/scratch/writer/tmp/oldctx-20260915T174500123Z.txt"
const notice = OldContext.tombstone(droppedFile)

describe("the packer says WHAT left, not only how much", () => {
  test("droppedMessages is the dropped set itself, and agrees with the count", () => {
    const result = pack(oversized, 12_000)
    expect(result.dropped).toBeGreaterThan(0)
    // ⚠️ THE AGREEMENT IS THE ASSERTION. A count and a text that can disagree about one request is
    // how a file ends up holding three messages while the log says four were cut.
    expect(result.droppedMessages.length).toBe(result.dropped)
    // ⚠️ Compared by OBJECT here, not by id: `Message.id` is optional and this fixture builds
    // messages without one, so `new Set(kept.map(m => m.id))` is `new Set([undefined])` and matches
    // everything. The packer's own comparison handles both (see `droppedFrom`); this assertion is
    // about the partition, so it uses the leg that is exact for this fixture.
    const keptObjects = new Set(result.messages)
    for (const message of result.droppedMessages) expect(keptObjects.has(message)).toBe(false)
    const droppedObjects = new Set(result.droppedMessages)
    for (const message of result.messages) expect(droppedObjects.has(message)).toBe(false)
    // The two sets partition the input: nothing is invented and nothing is lost in the accounting.
    expect(result.droppedMessages.length + result.messages.length).toBe(oversized.length)
  })

  test("a demoted system message is NOT reported as dropped", () => {
    // 🔴 The trap this pins: `demoteSystemMessages` returns NEW objects for the system messages it
    // rewrites, and those messages are still in the window. A difference by object identity would
    // report this message as dropped, and the caller would write a file naming text the model can
    // still read — a lie in the direction that matters.
    const messages = [Message.system("harness note"), Message.user("hello"), Message.assistant("hi")]
    const result = pack(messages, 200_000)
    expect(result.dropped).toBe(0)
    expect(result.droppedMessages).toEqual([])
  })
})

describe("the tombstone is reserved before the measurement and emitted only when true", () => {
  test("nothing dropped: the system prompt is byte-identical, notice or not", () => {
    const small = request([Message.user("hello"), Message.assistant("hi")], "you are a colleague")
    const plain = packRequest({ request: small, contextSize: 200_000 })
    const withNotice = packRequest({ request: small, contextSize: 200_000, droppedContextFile: droppedFile })
    expect(plain.dropped).toBe(0)
    expect(withNotice.dropped).toBe(0)
    // ⭐ A line naming a file that was never written is worse than no line: the agent greps the path,
    // finds nothing, and learns that its harness lies. Reserved, then withdrawn.
    expect(withNotice.system).toEqual(plain.system)
    expect(SystemPart.content(withNotice.system).some((part) => part.text.includes("holds earlier chat"))).toBe(false)
  })

  test("something dropped: the notice is a tail message and the system stays byte-identical", () => {
    const packed = packRequest({ request: request(oversized, "you are a colleague"), contextSize: 12_000 })
    const withNotice = packRequest({
      request: request(oversized, "you are a colleague"),
      contextSize: 12_000,
      droppedContextFile: droppedFile,
    })
    expect(withNotice.dropped).toBeGreaterThan(0)
    const parts = SystemPart.content(withNotice.system)
    expect(parts).toHaveLength(1)
    // The system prompt the invariant says to keep is still first and untouched.
    expect(parts[0]?.text).toBe("you are a colleague")
    // ⚠️ `preservesWireShape` is the guard that exists to catch a message injected after packing. The
    // tombstone is not one: the notice rides `system`, and the message list keeps its roles, count and
    // part types. Anything else is a wire the provider's prefix cache has never seen.
    expect(withNotice.system).toEqual(packed.system)
    expect(JSON.stringify(withNotice.messages.at(-1))).toContain(notice)
    expect(withNotice.messages.at(-1)?.role).toBe("user")
  })

  test("the notice's room is reserved BEFORE the packer measures", () => {
    // The reservation is not a formality: it costs room, so it can only ever drop MORE. Both halves
    // are asserted — never fewer (the direction that would overflow), and strictly more somewhere in
    // the range (proof the packer actually saw the line rather than the caller appending it later).
    //
    // ⚠️ The fixture is deliberately MANY SMALL messages over a WIDE window range. Measured, twice:
    // with two 12,000-token messages the drop count is 2 at every window in range, so a 28-token
    // notice cannot move it. An explicit response allowance pins this fixture's boundary independently
    // of heuristic reserve floors, which scale down on small models.
    const many = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? Message.user(`turn ${index} ${"x ".repeat(60)}`)
        : Message.assistant(`reply ${index} ${"y ".repeat(40)}`),
    )
    const bounded = LLM.request({ ...LLM.requestInput(request(many)), generation: { maxTokens: 8_192 } })
    let strict = 0
    for (let contextSize = 8_000; contextSize <= 30_000; contextSize += 100) {
      const without = packRequest({ request: bounded, contextSize })
      const withNotice = packRequest({ request: bounded, contextSize, droppedContextFile: droppedFile })
      expect(withNotice.dropped).toBeGreaterThanOrEqual(without.dropped)
      if (withNotice.dropped > without.dropped) strict++
    }
    expect(strict).toBeGreaterThan(0)
  })
})

describe("the request that leaves names the file the caller will write", () => {
  test("ProviderDispatch.prepare carries the notice at the conversation tail", () => {
    // The end of the chain: `prepare` is the last thing between the packer and the wire, and it is
    // pure — it is TOLD the line, never asked to produce one, because the caller is who writes the
    // file. This asserts the line survives that rebuild rather than being dropped with the old system.
    const prepared = ProviderDispatch.prepare({
      request: request(oversized, "you are a colleague"),
      promptCacheKey: "cache-key",
      contextSize: 12_000,
      droppedContextFile: droppedFile,
    })
    expect(prepared.packed.dropped).toBeGreaterThan(0)
    expect(SystemPart.content(prepared.request.system).some((part) => part.text === notice)).toBe(false)
    expect(JSON.stringify(prepared.request.messages.at(-1))).toContain(notice)
    expect(prepared.packed.droppedMessages.length).toBe(prepared.packed.dropped)
  })

  test("no notice passed: the packed request is what it always was", () => {
    // Backwards compatibility is not a courtesy here, it is the blast radius: `prepare` is on every
    // turn, and a caller that never heard of clause 2 must pack exactly as before.
    const prepared = ProviderDispatch.prepare({
      request: request(oversized, "you are a colleague"),
      promptCacheKey: "cache-key",
      contextSize: 12_000,
    })
    const plain = packRequest({ request: request(oversized, "you are a colleague"), contextSize: 12_000 })
    expect(prepared.packed.dropped).toBe(plain.dropped)
    expect(prepared.packed.system).toEqual(plain.system)
  })
})
