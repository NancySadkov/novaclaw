import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProviderCapability } from "@novaclaw/core/provider-capability"
import { probeCapabilities, probeLimits } from "../../src/server/routes/instance/httpapi/handlers/provider"

/**
 * CAPABILITY NEGOTIATION over recorded endpoint responses.
 *
 * `provider-capability.test.ts` covers the readers in isolation. What only this level can check is
 * the ASSEMBLY: which requests go out, in what order, and how each response maps onto a rung — the
 * places where a fault can quietly be recorded as a capability, which is permanent, or a capability
 * as a fault, which re-probes forever.
 */

/** Replies in the order the rungs are asked, and records what was sent. */
const run = async (
  replies: ReadonlyArray<Response>,
  options: {
    readonly authStyle?: "bearer" | "anthropic"
    readonly chat?: ProviderCapability.Outcome
    readonly limits?: { readonly timeout: Duration.Duration; readonly maxTokens: number }
  } = {},
) => {
  const sent: Array<Record<string, unknown>> = []
  const urls: Array<string> = []
  let next = 0
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url)
      const body = yield* Effect.promise(async () => {
        const raw = (request as { body?: { body?: unknown } }).body?.body
        try {
          return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as never)) as Record<
            string,
            unknown
          >
        } catch {
          return {}
        }
      })
      sent.push(body)
      const reply = replies[next++] ?? new Response("{}", { status: 200 })
      return HttpClientResponse.fromWeb(request, reply)
    }),
  )
  const report = await Effect.runPromise(
    probeCapabilities(client, {
      baseURL: "http://model.test/v1",
      modelID: "served-id",
      authStyle: options.authStyle ?? "bearer",
      headers: {},
      chat: options.chat ?? { kind: "supported" },
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    }),
  )
  return { report, sent, urls }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const message = (content: string, finish = "stop") =>
  json({ choices: [{ message: { content }, finish_reason: finish }] })

const nativeCall = (args: unknown) =>
  json({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { name: ProviderCapability.CAPTURE_TOOL.name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  })

const GOOD_ARGS = { label: "x", count: 3, nested: { left: "a", right: "b" } }

describe("what the negotiation asks", () => {
  test("three rungs, and the tool one offers ONLY the capture-only tool", async () => {
    const { sent } = await run([message('{"ok":true}'), nativeCall(GOOD_ARGS), message("{}")])
    expect(sent).toHaveLength(3)
    expect(sent[0]?.["response_format"]).toEqual({ type: "json_object" })
    // Nothing but the capture tool is ever offered: the probe must not be able to cause a side
    // effect, and there is no executor here to forget that.
    const tools = sent[1]?.["tools"] as Array<{ function: { name: string } }>
    expect(tools.map((t) => t.function.name)).toEqual([ProviderCapability.CAPTURE_TOOL.name])
    // The text rung offers no tools at all — it is measuring what the model does UNPROMPTED by the
    // tools array, which is the whole point of the prompted channel.
    expect(sent[2]?.["tools"]).toBeUndefined()
  })

  test("🔴 every rung asks for room a reasoning model needs before its first token", async () => {
    // The defect this pins: at 64 tokens the JSON rung came back empty on a real endpoint and scored
    // `unsupported` — a permanent wrong verdict recorded for OUR budget.
    const { sent } = await run([message('{"ok":true}'), nativeCall(GOOD_ARGS), message("{}")])
    for (const body of sent) expect(body["max_tokens"]).toBeGreaterThanOrEqual(256)
  })
})

describe("mapping a response onto a rung", () => {
  test("a healthy endpoint reads native", async () => {
    const { report } = await run([message('{"ok":true}'), nativeCall(GOOD_ARGS), message("{}")])
    expect(report.choice).toBe("native")
    expect(report.outcomes.json.kind).toBe("supported")
    expect(report.outcomes["native-tools"].kind).toBe("supported")
  })

  test("🔴 a spent-and-empty completion is a FAULT on the rung, not a missing capability", async () => {
    const spent = json({ choices: [{ message: { content: null }, finish_reason: "length" }] })
    const { report } = await run([spent, nativeCall(GOOD_ARGS), message("{}")])
    expect(report.outcomes.json).toMatchObject({ kind: "unknown", fault: "budget" })
    // And it does not drag the other rungs down with it.
    expect(report.choice).toBe("native")
  })

  test("🔴 the native rung checks the CALL before the budget — a native answer has empty content", async () => {
    // Testing the budget first would score every healthy native answer as a fault, because a tool
    // call legitimately arrives with `content: null`.
    const { report } = await run([
      message('{"ok":true}'),
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  function: {
                    name: ProviderCapability.CAPTURE_TOOL.name,
                    arguments: JSON.stringify(GOOD_ARGS),
                  },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
      }),
      message("{}"),
    ])
    expect(report.outcomes["native-tools"].kind).toBe("supported")
  })

  test("🔴 a 4xx that NAMES the rejected parameter is unsupported; anything else is unknown", async () => {
    const named = await run([
      json({ error: "unknown parameter: response_format" }, 400),
      json({ error: "unsupported field: tools" }, 400),
      message("{}"),
    ])
    expect(named.report.outcomes.json.kind).toBe("unsupported")
    expect(named.report.outcomes["native-tools"].kind).toBe("unsupported")

    const vague = await run([json({ error: "bad request" }, 400), json({ error: "bad request" }, 400), message("{}")])
    expect(vague.report.outcomes.json).toMatchObject({ kind: "unknown", fault: "http" })
    // Both tool rungs unmeasured ⇒ NOT chat-only. A wrong "no tools" is permanent.
    expect(vague.report.choice).toBe("unknown")
  })

  test("the prompted rung recovers a bare-JSON call, which is what the runner reads", async () => {
    const { report } = await run([
      message('{"ok":true}'),
      message("I would rather not."),
      message(`{"name":"${ProviderCapability.CAPTURE_TOOL.name}","arguments":${JSON.stringify(GOOD_ARGS)}}`),
    ])
    expect(report.outcomes["native-tools"].kind).toBe("unsupported")
    expect(report.outcomes["text-tools"].kind).toBe("supported")
    expect(report.choice).toBe("prompted")
  })

  test("🔴 a tool call naming something never offered fails the rung by name", async () => {
    const { report } = await run([
      message('{"ok":true}'),
      json({
        choices: [
          {
            message: { content: null, tool_calls: [{ function: { name: "get_weather", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
      message("nope"),
    ])
    expect(report.outcomes["native-tools"]).toMatchObject({
      kind: "unsupported",
      detail: expect.stringContaining("never offered"),
    })
  })
})

describe("which serving process answered", () => {
  test("🔴 it is read off a response the probe ALREADY made, never a fourth request", () => {
    // Asking again would spend a generation to learn something three responses already said.
    // (Assertion is on the request count; the value itself is checked below.)
    return run([
      json({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        system_fingerprint: "vllm-x-a44fe734",
      }),
      nativeCall(GOOD_ARGS),
      message("{}"),
    ]).then(({ report, sent }) => {
      expect(sent).toHaveLength(3)
      expect((report as { servedBy?: string }).servedBy).toBe("vllm-x-a44fe734")
    })
  })

  test("the FIRST rung to report it settles it", async () => {
    // vLLM repeats it on every response; taking the first means a later rung that omits it cannot
    // erase an identity we already have.
    const { report } = await run([
      json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], system_fingerprint: "first" }),
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { function: { name: ProviderCapability.CAPTURE_TOOL.name, arguments: JSON.stringify(GOOD_ARGS) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        system_fingerprint: "second",
      }),
      message("{}"),
    ])
    expect((report as { servedBy?: string }).servedBy).toBe("first")
  })

  test("an endpoint that reports none says nothing", async () => {
    const { report } = await run([message('{"ok":true}'), nativeCall(GOOD_ARGS), message("{}")])
    expect((report as { servedBy?: string }).servedBy).toBeUndefined()
  })

  test("🔴 a SKIPPED negotiation carries no identity — nothing answered, so nothing served it", async () => {
    const { report } = await run([], { chat: { kind: "unknown", fault: "transport", detail: "timeout" } })
    expect((report as { servedBy?: string }).servedBy).toBeUndefined()
  })
})

describe("what it refuses to guess", () => {
  test("🔴 no chat means the rungs are NOT asked — the same failure three more times is not evidence", async () => {
    const { report, sent } = await run([], { chat: { kind: "unknown", fault: "transport", detail: "timeout" } })
    expect(sent).toHaveLength(0)
    for (const rung of ["json", "native-tools", "text-tools"] as const)
      expect(report.outcomes[rung]).toMatchObject({ kind: "unknown", fault: "not-attempted" })
    expect(report.choice).toBe("unknown")
  })
})

/**
 * THE SECOND WIRE. Every verdict below is decided by the same rung code as the OpenAI arm — only the
 * envelope differs, which is the whole point of the split.
 *
 * ⚠️ Assembly only. These fixtures are the shapes the shipped `anthropic-messages` protocol encodes
 * and decodes, and they prove the probe builds the right request and reads the right fields. No
 * verdict here has been taken from a live Anthropic endpoint, which is a different claim and is
 * recorded as such in ``.
 */
describe("the Anthropic messages wire", () => {
  const block = (blocks: ReadonlyArray<unknown>, stop = "end_turn") =>
    new Response(JSON.stringify({ content: blocks, stop_reason: stop }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  const say = (text: string, stop = "end_turn") => block([{ type: "text", text }], stop)
  const useTool = (name: string, input: unknown) => block([{ type: "tool_use", id: "tu_1", name, input }], "tool_use")
  const anth = { authStyle: "anthropic" as const }

  test("🔴 it posts to /messages — the OpenAI path would 404 and read as a dead endpoint", async () => {
    const { urls } = await run([useTool(ProviderCapability.CAPTURE_TOOL.name, GOOD_ARGS), say("{}")], anth)
    expect(urls).toHaveLength(2)
    for (const url of urls) expect(url).toBe("http://model.test/v1/messages")
  })

  test("🔴 the JSON rung is NOT ASKED and NOT unsupported — this wire has no such parameter", async () => {
    // "The endpoint rejects JSON mode" is a claim about the endpoint; "the wire has no JSON-mode
    // parameter" is a fact about the protocol. Recording the first would blame a server for its
    // wire's vocabulary, permanently.
    const { report, sent } = await run([useTool(ProviderCapability.CAPTURE_TOOL.name, GOOD_ARGS), say("{}")], anth)
    expect(sent).toHaveLength(2)
    expect(report.outcomes.json).toMatchObject({ kind: "unknown", fault: "not-attempted" })
    expect(report.outcomes.json.kind === "unknown" && report.outcomes.json.detail).toContain("response-format")
    // And a rung nobody could ask does not drag the choice down.
    expect(report.choice).toBe("native")
  })

  test("the capture tool is offered in THIS wire's tool shape, and max_tokens is always present", async () => {
    const { sent } = await run([useTool(ProviderCapability.CAPTURE_TOOL.name, GOOD_ARGS), say("{}")], anth)
    const tools = sent[0]?.["tools"] as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.["name"]).toBe(ProviderCapability.CAPTURE_TOOL.name)
    // `input_schema`, not `function.parameters` — and nothing nested under `function`.
    expect(tools[0]?.["input_schema"]).toEqual(ProviderCapability.CAPTURE_TOOL.parameters)
    expect(tools[0]?.["function"]).toBeUndefined()
    // ⚠️ Required on this wire: omitting it is a 400, and the rung would then measure our request.
    for (const body of sent) expect(body["max_tokens"]).toBeGreaterThanOrEqual(256)
    // The prompted rung offers no tools at all — it measures what the model does UNPROMPTED by them.
    expect(sent[1]?.["tools"]).toBeUndefined()
  })

  test("a tool_use block reads as native support", async () => {
    const { report } = await run([useTool(ProviderCapability.CAPTURE_TOOL.name, GOOD_ARGS), say("{}")], anth)
    expect(report.outcomes["native-tools"].kind).toBe("supported")
    expect(report.choice).toBe("native")
  })

  test("🔴 arguments arrive PARSED on this wire and still face the same argument reader", async () => {
    // The OpenAI wire delivers a JSON string; this one delivers an object. A second argument reader
    // for the second shape is a second definition of "a well-formed call".
    const { report } = await run([useTool(ProviderCapability.CAPTURE_TOOL.name, { label: "x" }), say("{}")], anth)
    expect(report.outcomes["native-tools"].kind).toBe("unsupported")
  })

  test("🔴 `max_tokens` is this wire's word for exhausted — a spent turn is a FAULT, not a verdict", async () => {
    const { report } = await run([block([], "max_tokens"), say("{}")], anth)
    expect(report.outcomes["native-tools"]).toMatchObject({ kind: "unknown", fault: "budget" })
  })

  test("the prompted rung recovers a bare-JSON call out of the text blocks", async () => {
    const { report } = await run(
      [
        say("I would rather not."),
        say(`{"name":"${ProviderCapability.CAPTURE_TOOL.name}","arguments":${JSON.stringify(GOOD_ARGS)}}`),
      ],
      anth,
    )
    expect(report.outcomes["native-tools"].kind).toBe("unsupported")
    expect(report.outcomes["text-tools"].kind).toBe("supported")
    expect(report.choice).toBe("prompted")
  })

  test("🔴 an OpenAI-shaped body from an Anthropic endpoint is MALFORMED, not a missing capability", async () => {
    // A gateway answering for the endpoint in the other wire's envelope says nothing about the
    // model. Scoring it as "no tools" would be a permanent wrong verdict from a proxy's reply.
    const openAIShaped = new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { report } = await run([openAIShaped, openAIShaped], anth)
    expect(report.outcomes["native-tools"]).toMatchObject({ kind: "unknown", fault: "malformed" })
    expect(report.choice).toBe("unknown")
  })

  test("no chat still means the rungs are not asked, on this wire too", async () => {
    const { report, sent } = await run([], { ...anth, chat: { kind: "unknown", fault: "transport", detail: "x" } })
    expect(sent).toHaveLength(0)
    expect(report.choice).toBe("unknown")
  })
})

describe("the probe's own limits are a SETTING, not a constant", () => {
  test("🔴 the shipped defaults clear a MEASURED slow local model, with headroom", () => {
    // 26.8s: a 4B thinking model on a laptop Vulkan build, thinking and then emitting the capture
    // call. At the old 30s bound that rung timed out and a natively-capable model was recorded as
    // unmeasured — the probe measuring itself, exactly like the token-budget defect before it.
    const shipped = probeLimits(undefined)
    expect(Duration.toSeconds(shipped.timeout)).toBeGreaterThanOrEqual(90)
    expect(shipped.maxTokens).toBeGreaterThanOrEqual(256)
  })

  test("🔴 a stored value WINS over the shipped default, in both directions", () => {
    // The self-healing law's actual test: the number is a property of the user's slowest model and
    // their hardware, so an operator whose probe times out must be able to raise it from inside the
    // OS. A default that could not be overridden would make a wrong channel permanent.
    const raised = probeLimits({ capability_probe_timeout_ms: 600_000, capability_probe_max_tokens: 4096 } as never)
    expect(Duration.toMillis(raised.timeout)).toBe(600_000)
    expect(raised.maxTokens).toBe(4096)
  })

  test("the configured budget is what every rung actually asks for", () => {
    // A knob nothing reads is worse than no knob: the screen would accept the value and the probe
    // would keep using its own.
    return run([message('{"ok":true}'), nativeCall(GOOD_ARGS), message("{}")], {
      limits: { timeout: Duration.seconds(120), maxTokens: 1234 },
    }).then(({ sent }) => {
      for (const body of sent) expect(body["max_tokens"]).toBe(1234)
    })
  })
})
