import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"

// `initial` only reads `request.tools`, so a minimal cast is enough to drive the
// real protocol state machine (initial -> step* -> onHalt) without a live model.
const request = (tools: string[]) => ({ tools: tools.map((name) => ({ name })) }) as unknown as LLMRequest

function decode(tools: string[], events: ReadonlyArray<Record<string, unknown>>): LLMEvent[] {
  let state = OpenAIChat.protocol.stream.initial(request(tools))
  const emitted: LLMEvent[] = []
  for (const event of events) {
    const [next, produced] = Effect.runSync(OpenAIChat.protocol.stream.step(state, event as never))
    state = next
    emitted.push(...produced)
  }
  emitted.push(...(OpenAIChat.protocol.stream.onHalt?.(state) ?? []))
  return emitted
}

const text = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] })
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] }
const structuredCall = (name: string, args: string) => ({
  choices: [
    { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] }, finish_reason: null },
  ],
})

const toolCalls = (events: LLMEvent[]) => events.filter(LLMEvent.is.toolCall)
const finishReason = (events: LLMEvent[]) => events.find(LLMEvent.is.finish)?.reason

describe("openai-chat — text-dumped tool-call recovery (A2 wiring)", () => {
  test("recovers a hermes <tool_call> dumped into text + continues the loop", () => {
    const events = decode(
      ["read", "bash"],
      [text('<tool_call>{"name":"read","arguments":{"filePath":"a.ts"}}</tool_call>'), stop],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ filePath: "a.ts" })
    // the loop must NOT halt: finish="stop" is rewritten to "tool-calls"
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("recovers a call split across deltas (streaming fragmentation)", () => {
    const events = decode(
      ["read"],
      [text('<tool_call>{"name":"re'), text('ad","arguments":{"filePath":"a.ts"}}</tool_call>'), stop],
    )
    expect(toolCalls(events).map((c) => c.name)).toEqual(["read"])
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("canonicalizes a recovered name (Read -> read)", () => {
    const events = decode(["read"], [text('<tool_call>{"name":"Read","arguments":{"filePath":"a"}}</tool_call>'), stop])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["read"])
  })

  test("ordinary prose is NOT misread as a call", () => {
    const events = decode(["read", "bash"], [text("Sure — I'll read the file and run a quick check."), stop])
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })

  test("prose with angle brackets (C++) is NOT misread", () => {
    const events = decode(["read"], [text("Use `std::vector<int> v;` then `v.push_back(1);`."), stop])
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })
})

const reasoning = (content: string) => ({ choices: [{ delta: { reasoning_content: content }, finish_reason: null }] })

// The live 2026-07-21 doom-loop signature (issues.md mask-token P2): the thinking model
// leaves the complete call in the REASONING channel while the visible text is only leaked
// mask-token debris. Scavenging reasoning is the LAST resort — gated on the text carrying
// no answer at all.
describe("openai-chat — reasoning-channel scavenge", () => {
  test("call in reasoning + mask-debris text recovers and continues the loop", () => {
    const events = decode(
      ["write", "read"],
      [
        reasoning('I need to create the file. write(path="perm-test.txt", content="hello")'),
        text("\n\n<|mask_start|><think>\n\n<|mask_end|>"),
        stop,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("write")
    expect(calls[0].input).toEqual({ path: "perm-test.txt", content: "hello" })
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("reasoning is NOT scavenged when the text carries a real answer", () => {
    const events = decode(
      ["write"],
      [reasoning('Maybe I could call write(path="x", content="y") here.'), text("Here is my final answer: 42."), stop],
    )
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })

  test("reasoning prose without a structured call recovers nothing", () => {
    const events = decode(
      ["write"],
      [reasoning("The user wants a file created. I should use the write tool for this."), text("<|mask_start|>"), stop],
    )
    expect(toolCalls(events).length).toBe(0)
  })

  test("text-recovered call wins over reasoning content", () => {
    const events = decode(
      ["write", "read"],
      [
        reasoning('First I considered read(filePath="other.ts").'),
        text("<write><parameter=path>a.txt</parameter></write>"),
        stop,
      ],
    )
    expect(toolCalls(events).map((c) => c.name)).toEqual(["write"])
  })
})

describe("openai-chat — structured tool calls unaffected", () => {
  test("a normal structured call still decodes", () => {
    const events = decode(
      ["read"],
      [structuredCall("read", '{"filePath":"a.ts"}'), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ filePath: "a.ts" })
  })

  test("structured call reporting finish=stop is still rewritten to tool-calls", () => {
    const events = decode(["read"], [structuredCall("read", '{"filePath":"a.ts"}'), stop])
    expect(toolCalls(events).length).toBe(1)
    expect(finishReason(events)).toBe("tool-calls")
  })
})

const toolCalls_ = { choices: [{ delta: {}, finish_reason: "tool_calls" }] }

describe("openai-chat — structured tool-name canonicalization (A1)", () => {
  test("case mismatch is canonicalized (Write -> write)", () => {
    const events = decode(["write", "read"], [structuredCall("Write", '{"filePath":"a"}'), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["write"])
  })

  test("near-typo is canonicalized (apply_path -> apply_patch)", () => {
    const events = decode(["apply_patch", "read"], [structuredCall("apply_path", '{"patch":"x"}'), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["apply_patch"])
  })

  test("an unknown structured name passes through unchanged (runner surfaces it, decoder doesn't drop)", () => {
    const events = decode(["read"], [structuredCall("frobnicate", "{}"), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["frobnicate"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A RECOVERED CALL IS AN ORDINARY CALL — the property the permission model rests on.
//
// Recovery happens in the DECODER, below the runner, and emits the same `toolCall` event a native
// call does. That is what makes "a text-dumped call cannot bypass permissions" true by CONSTRUCTION
// rather than by every consumer remembering to check: there is no second path to forget.
//
// ⚠️ The failure this guards is a refactor that special-cases recovered calls — tagging them, routing
// them, executing them directly. Nothing would fail: the calls would still work, and the gate would
// simply stop applying to them, which is the one class of bug you cannot see from the outside.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a recovered call is indistinguishable from a native one", () => {
  const ARGS = '{"filePath":"a.ts"}'

  test("🔴 the same event shape, field for field, apart from the id", () => {
    const native = toolCalls(decode(["read"], [structuredCall("read", ARGS), stop]))
    const recovered = toolCalls(
      decode(["read"], [text(`<tool_call>{"name":"read","arguments":${ARGS}}</tool_call>`), stop]),
    )
    expect(native.length).toBe(1)
    expect(recovered.length).toBe(1)
    // Ids differ by design (`call_recovered_*` is traceable); everything a consumer routes or gates
    // on must not.
    const shape = (call: (typeof native)[number]) => ({ ...call, id: undefined })
    expect(shape(recovered[0]!)).toEqual(shape(native[0]!))
  })

  test("🔴 no marker rides along with a VALUE a consumer could branch on", () => {
    // If a recovered call ever carried "this came from text", something downstream would eventually
    // treat it differently — and the difference that matters is the permission assert.
    //
    // ⚠️ Key PRESENCE is deliberately not the assertion. A native call carries `providerExecuted` and
    // `providerMetadata` as undefined-valued keys and a recovered one omits them; both read as
    // `undefined` at every consumer, so that difference is invisible and harmless. What must not
    // exist is a key with a DEFINED value on one and not the other.
    const [recovered] = toolCalls(
      decode(["read"], [text(`<tool_call>{"name":"read","arguments":${ARGS}}</tool_call>`), stop]),
    )
    const [native] = toolCalls(decode(["read"], [structuredCall("read", ARGS), stop]))
    const defined = (call: object) =>
      Object.entries(call)
        .filter(([key, value]) => key !== "id" && value !== undefined)
        .map(([key]) => key)
        .sort()
    expect(defined(recovered!)).toEqual(defined(native!))
    // ⚠️ The ID is the ONE deliberate difference — `call_recovered_*` is traceable in a transcript,
    // which is worth having. Everything else must be silent about provenance, and nothing may branch
    // on the id: it is a label for a human reading a log, not a routing key.
    const { id: _id, ...rest } = recovered as unknown as Record<string, unknown>
    expect(JSON.stringify(rest)).not.toMatch(/recovered|fromText|provenance/i)
  })

  test("🔴 an unoffered name is recovered as NOTHING — not as a call for the gate to refuse", () => {
    // The whitelist is the first line: a hallucinated name never becomes a call at all, so nothing
    // downstream has to recognise it. `read` is offered; `rm` is not.
    const events = decode(["read"], [text('<tool_call>{"name":"rm","arguments":{"path":"/"}}</tool_call>'), stop])
    expect(toolCalls(events)).toHaveLength(0)
  })

  test("a structured call WINS — recovery never adds a second call to the same turn", () => {
    // Both channels carrying a call would otherwise execute it twice, which for a write tool is a
    // duplicated side effect rather than a duplicated answer.
    const events = decode(
      ["read"],
      [structuredCall("read", ARGS), text(`<tool_call>{"name":"read","arguments":${ARGS}}</tool_call>`), stop],
    )
    expect(toolCalls(events)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHICH SERVING PROCESS ANSWERED.
//
// `model` echoes the ALIAS we asked for, so an alias repointed at different weights is invisible in
// it. `system_fingerprint` is the only serving identity this wire offers — measured 2026-08-13 as
// stable across calls to one server and different between two servers on the same vLLM build.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const served = (fingerprint: string, content = "hi") => ({
  choices: [{ delta: { content }, finish_reason: null }],
  system_fingerprint: fingerprint,
})

describe("the serving identity reaches the finish event", () => {
  const finishOf = (events: LLMEvent[]) => events.find(LLMEvent.is.finish)

  test("it rides providerMetadata, the channel that already exists for un-normalised facts", () => {
    const events = decode([], [served("vllm-x-a44fe734"), stop])
    expect(finishOf(events)?.providerMetadata).toEqual({ openai: { system_fingerprint: "vllm-x-a44fe734" } })
  })

  test("🔴 a chunk that omits it does not ERASE it — vLLM repeats it, a truncated tail may not", () => {
    // The failure this forbids is quiet: the identity arrives on chunk one, the final chunk carries
    // no fingerprint, and the finish event reports nothing — so a turn that WAS attributable looks
    // like one from an endpoint that does not report identity at all.
    const events = decode([], [served("vllm-x-a44fe734"), { choices: [{ delta: { content: "!" }, finish_reason: null }] }, stop])
    expect(finishOf(events)?.providerMetadata).toEqual({ openai: { system_fingerprint: "vllm-x-a44fe734" } })
  })

  test("an endpoint that reports no identity says nothing, rather than 'unknown'", () => {
    // Absent is honest: most wires do not report this, and a synthesised "unknown" would read as a
    // measurement that failed rather than a question never asked.
    const events = decode([], [{ choices: [{ delta: { content: "hi" }, finish_reason: null }] }, stop])
    expect(finishOf(events)?.providerMetadata).toBeUndefined()
  })
})
