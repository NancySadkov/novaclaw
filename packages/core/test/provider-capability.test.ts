import { describe, expect, test } from "bun:test"
import { ProviderCapability } from "@novaclaw/core/provider-capability"

/**
 * The negotiator's whole job is telling three answers apart — *it can*, *it cannot*, *we could not
 * find out* — and every case below is a way to get that wrong.
 *
 * The stakes are asymmetric, which is why the tests lean where they do: a wrong `unsupported` is
 * PERMANENT (an endpoint demoted to prompted tools on the strength of a network blip, with nothing
 * downstream able to tell), while a wrong `unknown` costs one more probe.
 */

const OFFERED = [ProviderCapability.CAPTURE_TOOL.name]

const wellFormed = {
  name: ProviderCapability.CAPTURE_TOOL.name,
  rawArguments: JSON.stringify({ label: "x", count: 3, nested: { left: "a", right: "b" } }),
}

describe("judging a tool call", () => {
  test("a complete call with its nested object intact is supported", () => {
    expect(ProviderCapability.readToolCall(wellFormed, OFFERED).kind).toBe("supported")
  })

  test("🔴 a call naming a tool that was never offered is UNSUPPORTED, and says why", () => {
    // The clearest evidence a tool channel invents names. An offered-tools whitelist is the only
    // thing between that and a runner executing something nobody granted, so measuring it here is
    // what lets the negotiator refuse the native rung on evidence instead of on a later incident.
    const outcome = ProviderCapability.readToolCall({ ...wellFormed, name: "get_weather" }, OFFERED)
    expect(outcome.kind).toBe("unsupported")
    expect(outcome.kind === "unsupported" && outcome.detail).toContain("never offered")
  })

  test("no call at all is unsupported, not a fault", () => {
    // The model answered — the endpoint worked. It simply did not use the channel.
    expect(ProviderCapability.readToolCall(undefined, OFFERED).kind).toBe("unsupported")
  })

  test("a truncated call is unsupported", () => {
    const truncated = { ...wellFormed, rawArguments: '{"label":"x","count":3,"nes' }
    const outcome = ProviderCapability.readToolCall(truncated, OFFERED)
    expect(outcome.kind).toBe("unsupported")
    expect(outcome.kind === "unsupported" && outcome.detail).toContain("JSON")
  })

  test("🔴 a call that drops arguments is caught — the multi-argument failure", () => {
    // A one-argument probe calls this endpoint healthy. That is why the capture tool takes three.
    const outcome = ProviderCapability.readToolCall(
      { ...wellFormed, rawArguments: JSON.stringify({ label: "x" }) },
      OFFERED,
    )
    expect(outcome.kind).toBe("unsupported")
    expect(outcome.kind === "unsupported" && outcome.detail).toContain("count")
  })

  test("🔴 a FLATTENED nested argument is caught — a required-keys check alone calls it healthy", () => {
    const flattened = { ...wellFormed, rawArguments: JSON.stringify({ label: "x", count: 3, nested: "left=a" }) }
    const outcome = ProviderCapability.readToolCall(flattened, OFFERED)
    expect(outcome.kind).toBe("unsupported")
    expect(outcome.kind === "unsupported" && outcome.detail).toContain("flattened")
  })

  test("a nested object that lost a field is caught", () => {
    const partial = { ...wellFormed, rawArguments: JSON.stringify({ label: "x", count: 3, nested: { left: "a" } }) }
    expect(ProviderCapability.readToolCall(partial, OFFERED).kind).toBe("unsupported")
  })
})

describe("recovering a tool call from text", () => {
  // ⚠️ These go through the RUNNER's own `recoverToolCallsFromText`, not a reader of this module's
  // own. A probe with its own parser would report "this endpoint can do prompted tools" for a format
  // the decoder cannot parse — a verdict about a channel that does not exist.

  test("the hermes shape the decoder already recovers is supported, fence and prose included", () => {
    const content =
      'Sure, here you go:\n```\n<tool_call>{"name":"nova_probe_capture","arguments":{"label":"x","count":1,"nested":{"left":"a","right":"b"}}}</tool_call>\n```'
    const call = ProviderCapability.recoverTextToolCall(content, OFFERED)
    expect(call?.name).toBe("nova_probe_capture")
    expect(ProviderCapability.readToolCall(call, OFFERED).kind).toBe("supported")
  })

  test("a bare JSON object naming an offered tool is recovered too", () => {
    // The decoder handles four shapes; the probe inherits all of them by asking it rather than
    // matching one format of its own.
    const call = ProviderCapability.recoverTextToolCall(
      '{"name":"nova_probe_capture","arguments":{"label":"x","count":1,"nested":{"left":"a","right":"b"}}}',
      OFFERED,
    )
    expect(ProviderCapability.readToolCall(call, OFFERED).kind).toBe("supported")
  })

  test("🔴 prose with angle brackets is NOT a call", () => {
    // The whitelist gate is what keeps `#include <vector>` and markdown out. Losing it here would
    // make every endpoint look capable of prompted tools.
    expect(
      ProviderCapability.recoverTextToolCall("I would call it, but here is `<vector>` instead", OFFERED),
    ).toBeUndefined()
  })

  test("a call naming a tool that was never offered recovers NOTHING", () => {
    // The gate lives in the recovery, so a hallucinated name never even reaches the payload check —
    // and the rung correctly reads as "the model did not call the tool it was offered".
    const call = ProviderCapability.recoverTextToolCall(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Berlin"}}</tool_call>',
      OFFERED,
    )
    expect(call).toBeUndefined()
    expect(ProviderCapability.readToolCall(call, OFFERED).kind).toBe("unsupported")
  })

  test("a recovered call that DROPPED arguments still fails the payload check", () => {
    // Whitelist-clean is not the same as usable: this is the half `readToolCall` still owns.
    const call = ProviderCapability.recoverTextToolCall(
      '<tool_call>{"name":"nova_probe_capture","arguments":{"label":"x"}}</tool_call>',
      OFFERED,
    )
    expect(call).toBeDefined()
    const outcome = ProviderCapability.readToolCall(call, OFFERED)
    expect(outcome.kind).toBe("unsupported")
    expect(outcome.kind === "unsupported" && outcome.detail).toContain("count")
  })
})

describe("a failure is not a capability", () => {
  const read = (): ProviderCapability.Outcome => ({ kind: "supported" })

  test("🔴 auth, transport and an opaque HTTP error are UNKNOWN, each with its own fault", () => {
    const auth = ProviderCapability.outcomeOf({ kind: "http", status: 401, body: "nope" }, { read })
    const transport = ProviderCapability.outcomeOf({ kind: "transport", detail: "ECONNRESET" }, { read })
    const http = ProviderCapability.outcomeOf({ kind: "http", status: 502, body: "<html>proxy</html>" }, { read })
    expect(auth).toMatchObject({ kind: "unknown", fault: "auth" })
    expect(transport).toMatchObject({ kind: "unknown", fault: "transport" })
    expect(http).toMatchObject({ kind: "unknown", fault: "http" })
  })

  test("🔴 a 4xx that NAMES the rejected parameter is evidence, and is unsupported", () => {
    // The one case where a failure says something about the endpoint. Left as `unknown` it would be
    // re-probed forever against a server that already answered.
    const outcome = ProviderCapability.outcomeOf(
      { kind: "http", status: 400, body: '{"error":"unknown parameter: tools"}' },
      { parameter: "tools", read },
    )
    expect(outcome).toMatchObject({ kind: "unsupported" })
  })

  test("a 4xx that merely mentions the parameter is NOT evidence", () => {
    // A wrong `unsupported` is permanent; a wrong `unknown` costs one probe. The bar sits there.
    const outcome = ProviderCapability.outcomeOf(
      { kind: "http", status: 400, body: "your tools request had a bad message role" },
      { parameter: "tools", read },
    )
    expect(outcome).toMatchObject({ kind: "unknown", fault: "http" })
  })
})

describe("a spent budget is a fault, not a verdict", () => {
  test("🔴 empty content with a length finish is NOT evidence about the endpoint", () => {
    // The probe got this wrong on itself, measured against Holo3.1: the JSON rung asked with 64
    // tokens, the model spent all of them reasoning, and the empty reply scored  — a
    // PERMANENT wrong verdict recorded for OUR budget on a rung the endpoint handles fine.
    expect(ProviderCapability.spentWithoutAnswering({ content: "", finishReason: "length" })).toBe(true)
    expect(ProviderCapability.spentWithoutAnswering({ content: "   ", finishReason: "length" })).toBe(true)
  })

  test("a length finish WITH content is an ordinary truncation, not a fault", () => {
    // Both halves are required. A truncated real answer is something we learned from; only an empty
    // one means we learned nothing.
    expect(ProviderCapability.spentWithoutAnswering({ content: '{"ok":tr', finishReason: "length" })).toBe(false)
  })

  test("an empty answer that stopped NORMALLY is the endpoint's own answer", () => {
    // A model that simply said nothing is a real (bad) result. Calling it a budget fault would hide
    // an endpoint that never answers behind "we could not find out".
    expect(ProviderCapability.spentWithoutAnswering({ content: "", finishReason: "stop" })).toBe(false)
    expect(ProviderCapability.spentWithoutAnswering({ content: "" })).toBe(false)
  })
})

describe("choosing the rung", () => {
  const outcomes = (
    over: Partial<Record<ProviderCapability.Capability, ProviderCapability.Outcome>>,
  ): Record<ProviderCapability.Capability, ProviderCapability.Outcome> => ({
    chat: { kind: "supported" },
    json: { kind: "supported" },
    "native-tools": { kind: "supported" },
    "text-tools": { kind: "supported" },
    ...over,
  })

  test("native when the native channel works", () => {
    expect(ProviderCapability.report(outcomes({})).choice).toBe("native")
  })

  test("prompted when native is measured unusable and text works", () => {
    const result = ProviderCapability.report(
      outcomes({ "native-tools": { kind: "unsupported", detail: "dropped count" } }),
    )
    expect(result.choice).toBe("prompted")
    expect(result.rationale).toContain("dropped count")
  })

  test("chat-only ONLY when both tool rungs were measured", () => {
    const result = ProviderCapability.report(
      outcomes({
        "native-tools": { kind: "unsupported", detail: "no call" },
        "text-tools": { kind: "unsupported", detail: "no call" },
      }),
    )
    expect(result.choice).toBe("chat-only")
  })

  test("🔴 an unmeasured tool rung is UNKNOWN, never chat-only", () => {
    // The failure this forbids: one auth blip on the tool probe permanently records "this endpoint
    // has no tools", and nothing downstream can tell that from a real measurement.
    const result = ProviderCapability.report(
      outcomes({
        "native-tools": { kind: "unknown", fault: "auth", detail: "401" },
        "text-tools": { kind: "unsupported", detail: "no call" },
      }),
    )
    expect(result.choice).toBe("unknown")
    expect(result.rationale).toContain("could not be measured")
  })

  test("no chat means nothing was measured at all", () => {
    const result = ProviderCapability.report(
      outcomes({
        chat: { kind: "unknown", fault: "transport", detail: "timeout" },
        "native-tools": { kind: "unknown", fault: "not-attempted", detail: "x" },
        "text-tools": { kind: "unknown", fault: "not-attempted", detail: "x" },
      }),
    )
    expect(result.choice).toBe("unknown")
  })
})

describe("the fingerprint", () => {
  test("🔴 the TEMPLATE is part of it — same URL, same model, different tool channel", () => {
    // The case stale evidence gets wrong: a server reloaded with a different chat template is the
    // same endpoint by every other measure, and its tool channel may have changed underneath.
    const base = { endpoint: "http://host:8010/v1", model: "holo3.1", protocol: "openai-chat" }
    expect(ProviderCapability.fingerprint({ ...base, template: "a" })).not.toBe(
      ProviderCapability.fingerprint({ ...base, template: "b" }),
    )
  })

  test("a trailing slash is not a different endpoint", () => {
    const a = ProviderCapability.fingerprint({ endpoint: "http://h/v1/", model: "m", protocol: "p" })
    const b = ProviderCapability.fingerprint({ endpoint: "http://h/v1", model: "m", protocol: "p" })
    expect(a).toBe(b)
  })
})

describe("reading the serving identity off a finished turn", () => {
  test("the `openai` namespace's `system_fingerprint` is the identity", () => {
    expect(ProviderCapability.servingIdentityOf({ openai: { system_fingerprint: "vllm-0.9.2-a44fe734" } })).toBe(
      "vllm-0.9.2-a44fe734",
    )
  })

  test("🔴 an EMPTY string is not an identity", () => {
    // Some servers send `""` when they have nothing to report. Recording it would make every such
    // turn read as a MOVE away from whatever real identity was seen before it.
    expect(ProviderCapability.servingIdentityOf({ openai: { system_fingerprint: "" } })).toBeUndefined()
  })

  test("absent metadata, another vendor's namespace, and a non-string all read as nothing", () => {
    expect(ProviderCapability.servingIdentityOf(undefined)).toBeUndefined()
    expect(ProviderCapability.servingIdentityOf({})).toBeUndefined()
    expect(ProviderCapability.servingIdentityOf({ anthropic: { system_fingerprint: "x" } })).toBeUndefined()
    expect(ProviderCapability.servingIdentityOf({ openai: { system_fingerprint: 42 } })).toBeUndefined()
    expect(ProviderCapability.servingIdentityOf({ openai: {} })).toBeUndefined()
  })
})

describe("the two wires read their own envelope and nobody else's", () => {
  const openai = ProviderCapability.WIRES["openai-chat"]
  const anthropic = ProviderCapability.WIRES["anthropic-messages"]
  const chatBody = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }
  const messagesBody = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }

  test("🔴 each wire REFUSES the other's envelope — a gateway's reply is not the model's answer", () => {
    // If either accepted the other's shape, a proxy answering in the wrong format would be scored as
    // a capability instead of landing as `malformed`.
    expect(openai.answered(chatBody)).toBe(true)
    expect(openai.answered(messagesBody)).toBe(false)
    expect(anthropic.answered(messagesBody)).toBe(true)
    expect(anthropic.answered(chatBody)).toBe(false)
  })

  test("🔴 'stopped at the ceiling' is a different WORD on each wire", () => {
    // One rule, two vocabularies. Reading `length` on the Anthropic wire would miss every budget
    // fault there and record it as a missing capability instead.
    expect(openai.exhausted({ choices: [{ message: {}, finish_reason: "length" }] })).toBe(true)
    expect(openai.exhausted({ choices: [{ message: {}, finish_reason: "max_tokens" }] })).toBe(false)
    expect(anthropic.exhausted({ content: [], stop_reason: "max_tokens" })).toBe(true)
    expect(anthropic.exhausted({ content: [], stop_reason: "length" })).toBe(false)
  })

  test("Anthropic text is JOINED across blocks — one block is not the answer", () => {
    const split = {
      content: [
        { type: "text", text: '{"ok":' },
        { type: "text", text: "true}" },
      ],
    }
    expect(anthropic.text(split)).toBe('{"ok":true}')
    // Thinking blocks are not the answer and must not be spliced into it.
    const thought = {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ],
    }
    expect(anthropic.text(thought)).toBe("answer")
  })

  test("a parsed Anthropic tool input is re-encoded for the ONE argument reader", () => {
    const call = anthropic.toolCall({
      content: [{ type: "tool_use", id: "tu_1", name: "nova_probe_capture", input: { label: "x" } }],
    })
    expect(call?.name).toBe("nova_probe_capture")
    expect(JSON.parse(call?.rawArguments ?? "{}")).toEqual({ label: "x" })
  })

  test("🔴 only ONE wire has a JSON-mode parameter, and that asymmetry is the point", () => {
    expect(openai.jsonMode?.parameter).toBe("response_format")
    expect(anthropic.jsonMode).toBeUndefined()
  })
})
