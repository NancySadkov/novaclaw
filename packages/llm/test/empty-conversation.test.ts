import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import * as Protocols from "../src/protocols"
import { Auth, LLMClient } from "../src/route"
import type { Protocol } from "../src/route/protocol"
import { LLMError, type LLMRequest } from "../src/schema"

// The mechanical check for ruling 1 on the empty-conversation guard (`route/protocol.ts`
// `guardConversation`). The invariant: **no protocol may send a body whose conversation array
// lowered to empty, and the refusal names the wire's own field.**
//
// ⚠️ **This is an ABSENCE assertion, so every claim here is written to be killable.** The failure
// mode to fear is a test that passes because it can never fire — this repo shipped two of those in
// one day (`not.toContain(windowsPath)` could not fire because `JSON.stringify` escapes `\`, and
// `not.toHaveProperty("holo3.1")` passed vacuously because bun reads a dotted argument as a path).
// So: the enumeration asserts it found something before iterating it; the refusal claims assert on
// the MESSAGE TEXT and the reason tag, not merely that something failed; and every refusal claim is
// paired with a control that must SUCCEED, so an always-refusing guard is as red as an absent one.
//
// ⚠️ **Not a re-litigation of `68d5029a2`.** That commit put the reasoning-only assistant DROP in
// `openai-chat.ts` because the question has six answers per wire. This file pins the question that
// has ONE answer on every wire — may the conversation array be empty — and it runs strictly after
// the drop. See `guardConversation`'s own comment.

// A cast request, the same minimal pattern the protocol body tests use: the lowering paths read
// `model.id`, `model.compatibility`, `model.route.defaults`, `system`, `messages`, `tools`.
const raw = (patch: Record<string, unknown>): LLMRequest =>
  ({
    model: { id: "test-model", route: { defaults: {} } },
    system: [],
    messages: [],
    tools: [],
    ...patch,
  }) as unknown as LLMRequest

const USER_TURN = { role: "user", content: [{ type: "text", text: "Say hello." }] }

// The MEASURED production shape (2026-07-31, B=2 at a 16k window): a session with zero user
// messages whose surviving entry is an assistant that only thought. `lowerAssistantMessage` drops
// it — that is `68d5029a2`'s guard doing its job — and what is left is nothing.
const REASONING_ONLY_ASSISTANT = {
  role: "assistant",
  content: [{ type: "reasoning", text: "I should think about this.", providerMetadata: {} }],
}

const SYSTEM_PART = [{ type: "text", text: "You are a helpful assistant." }]

// oxlint-disable-next-line typescript-eslint/no-explicit-any
type AnyProtocol = Protocol<any, any, any, any>

interface Entry {
  readonly export: string
  readonly protocol: AnyProtocol
}

const hasProtocol = (value: unknown): value is { readonly protocol: AnyProtocol } =>
  typeof value === "object" &&
  value !== null &&
  "protocol" in value &&
  typeof (value as { protocol?: { body?: unknown } }).protocol?.body === "object"

// Enumerated from the module's own exports rather than hand-listed, so a protocol added to
// `protocols/index.ts` is covered on the day it lands instead of the day someone remembers.
const entries: Entry[] = [
  ...Object.entries(Protocols).flatMap(([name, value]) =>
    hasProtocol(value) ? [{ export: name, protocol: value.protocol }] : [],
  ),
]

/**
 * What each wire calls its turn array, and which protocol id owns the refusal.
 *
 * 🔴 **These are LITERALS on purpose, and the first draft of this file got it wrong.** The
 * assertion below used to read the expected name off `protocol.body.conversation.name` — i.e. off
 * the very declaration under test — so renaming Gemini's field from `contents` to `messages`
 * changed both sides at once and the test stayed green. A mutation sweep caught it. An expectation
 * derived from its subject is not an expectation.
 *
 * `refusedBy` is the protocol id that appears in the diagnostic message.
 */
const EXPECTED: Record<string, { readonly field: string; readonly refusedBy: string }> = {
  OpenAIChat: { field: "messages", refusedBy: "openai-chat" },
  OpenAIResponses: { field: "input", refusedBy: "openai-responses" },
  AnthropicMessages: { field: "messages", refusedBy: "anthropic-messages" },
  Gemini: { field: "contents", refusedBy: "gemini" },
}

const refusalOf = (protocol: AnyProtocol, request: LLMRequest) =>
  Effect.runSync(protocol.body.from(request).pipe(Effect.flip))

describe("no protocol sends an empty conversation (the guard's own check)", () => {
  test("the enumeration really found protocols — a zero-length loop proves nothing", () => {
    // Without this the two loops below are vacuous the day the barrel is renamed.
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(entries.map((entry) => entry.export).sort()).toEqual([
      "AnthropicMessages",
      "Gemini",
      "OpenAIChat",
      "OpenAIResponses",
    ])
  })

  test("openai-compatible-chat inherits the guard BY IDENTITY — it declares no protocol of its own", () => {
    // It is absent from the list above for a reason worth pinning rather than explaining: it reuses
    // `OpenAIChat.protocol` wholesale, so there is one guarded `body` object and it is the same one.
    // This is also the local vLLM/qwen path, i.e. the wire where the defect actually bites.
    expect(Protocols.OpenAICompatibleChat.route.body).toBe(Protocols.OpenAIChat.protocol.body)
  })

  test("every discovered protocol has a pinned expectation — a new one cannot slip through untested", () => {
    expect(entries.map((entry) => entry.export).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const entry of entries) {
    // A sentinel rather than `!`: a protocol with no pinned row produces expectations that cannot
    // match, so it goes red here as well as in the enumeration test above — never silently skipped.
    const expected = EXPECTED[entry.export] ?? { field: "<unpinned>", refusedBy: "<unpinned>" }

    test(`${entry.export}: declares its wire's own field name (\`${expected.field}\`)`, () => {
      // The independent half. `EXPECTED` is written from each wire's published body shape, not read
      // off the declaration, so a rename here is a mismatch rather than a silent agreement.
      expect(entry.protocol.body.conversation.name).toBe(expected.field)
    })

    test(`${entry.export}: a request with no messages and no system is REFUSED, naming that field`, () => {
      const error = refusalOf(entry.protocol, raw({}))
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason._tag).toBe("InvalidRequest")
      // Assert on the TEXT against the literal, so renaming a protocol's `conversation.name` — or
      // pointing `read` at a field that is never empty — turns this red rather than passing on
      // "something failed".
      expect(error.reason.message).toContain(`${expected.refusedBy} has nothing to send: \`${expected.field}\``)
      // The counts are the diagnostic half: they separate "the caller sent nothing" from
      // "everything the caller sent was dropped at lowering".
      expect(error.reason.message).toContain("0 message(s) and 0 system part(s)")
    })

    test(`${entry.export}: CONTROL — one ordinary user turn compiles, so the guard is not always-on`, () => {
      const body = Effect.runSync(entry.protocol.body.from(raw({ messages: [USER_TURN] })))
      // Two claims, because "it did not throw" is the weaker one: the declared accessor must also
      // be pointing at an array that actually received the turn.
      expect(entry.protocol.body.conversation.read(body).length).toBeGreaterThan(0)
    })
  }
})

// ⚖️ This block is the mechanical consequence of the 2026-08-07 ruling that `ContextPack.pack` does
// NOT owe a "says something" postcondition (argued in full at `guardConversation` in
// `route/protocol.ts`). The ruling only holds if the shape `pack` CAN emit — a session with no real
// user message, whose kept-set is a lone reasoning-only assistant — is refused here by name. If a
// future edit makes that shape reach a backend, the ruling has quietly become false and these go red.
describe("the measured case — a session with zero user messages", () => {
  test("openai-chat: a lone reasoning-only assistant is refused, not shipped as `messages: []`", () => {
    const error = refusalOf(Protocols.OpenAIChat.protocol, raw({ messages: [REASONING_ONLY_ASSISTANT] }))
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.reason.message).toContain("`messages` is empty after lowering 1 message(s) and 0 system part(s)")
  })

  test("openai-chat: CONTROL — the PRODUCTION floor still compiles, because system lands in `messages`", () => {
    // `@novaclaw/core`'s `SystemCompose` always supplies a baseline, which is why this defect was
    // production-mitigated and reachable only through the public surface. That mitigation must keep
    // working: on THIS wire the system prompt is a `messages` entry, so the same dropped assistant
    // leaves a legal one-entry body.
    const body = Effect.runSync(
      Protocols.OpenAIChat.protocol.body.from(raw({ messages: [REASONING_ONLY_ASSISTANT], system: SYSTEM_PART })),
    )
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]).toMatchObject({ role: "system" })
  })

  test("anthropic-messages: a system prompt alone is STILL refused — `system` is its own top-level field", () => {
    // The discriminating pair. A system-only request compiles on openai-chat (previous test) and is
    // refused here, from the SAME input — which is only possible if each protocol's `read` points
    // at its own wire's array. A single shared accessor, or a guard that counted `request.system`,
    // would agree on both and so could not produce this asymmetry.
    const error = refusalOf(Protocols.AnthropicMessages.protocol, raw({ system: SYSTEM_PART }))
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.reason.message).toContain("`messages` is empty after lowering 0 message(s) and 1 system part(s)")
  })

  test("openai-chat: CONTROL for the pair above — a system prompt alone COMPILES on this wire", () => {
    const body = Effect.runSync(Protocols.OpenAIChat.protocol.body.from(raw({ system: SYSTEM_PART })))
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]).toMatchObject({ role: "system" })
  })

  test("anthropic-messages: a reasoning-only assistant is NOT dropped here — the per-wire ruling is intact", () => {
    // Guarding against a plausible wrong fix: someone reading this file could conclude the drop
    // should be shared too. It must not be. `68d5029a2` measured six answers for one input, and
    // Anthropic's is a legal `thinking` block carrying the signature it must echo back. If this
    // ever starts refusing, a per-wire lowering was collapsed into a shared one.
    const body = Effect.runSync(
      Protocols.AnthropicMessages.protocol.body.from(raw({ messages: [REASONING_ONLY_ASSISTANT] })),
    )
    expect(body.messages).toHaveLength(1)
  })
})

describe("reachable through the PUBLIC surface — the reason this needed a guard at all", () => {
  const route = OpenAIChat_route()

  function OpenAIChat_route() {
    return Protocols.OpenAIChat.route.with({
      endpoint: { baseURL: "https://api.openai.test/v1/" },
      auth: Auth.bearer("test"),
    })
  }

  test("LLMClient.prepare refuses — plugins and the SDK reach the wire through this, not through `body.from`", () => {
    const error = Effect.runSync(
      LLMClient.prepare(LLM.request({ model: route.model({ id: "test-model" }) })).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.reason.message).toContain("openai-chat has nothing to send")
  })

  test("CONTROL — the same public call with a prompt prepares a body", () => {
    const prepared = Effect.runSync(
      LLMClient.prepare<Protocols.OpenAIChat.OpenAIChatBody>(
        LLM.request({ model: route.model({ id: "test-model" }), prompt: "Say hello." }),
      ),
    )
    expect(prepared.body.messages).toHaveLength(1)
  })
})
