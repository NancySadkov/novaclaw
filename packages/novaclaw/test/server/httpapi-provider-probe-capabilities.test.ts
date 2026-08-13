import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProviderCapability } from "@novaclaw/core/provider-capability"
import { probeCapabilities } from "../../src/server/routes/instance/httpapi/handlers/provider"

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
  options: { readonly authStyle?: "bearer" | "anthropic"; readonly chat?: ProviderCapability.Outcome } = {},
) => {
  const sent: Array<Record<string, unknown>> = []
  let next = 0
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
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
    }),
  )
  return { report, sent }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const message = (content: string, finish = "stop") => json({ choices: [{ message: { content }, finish_reason: finish }] })

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

describe("what it refuses to guess", () => {
  test("🔴 no chat means the rungs are NOT asked — the same failure three more times is not evidence", async () => {
    const { report, sent } = await run([], { chat: { kind: "unknown", fault: "transport", detail: "timeout" } })
    expect(sent).toHaveLength(0)
    for (const rung of ["json", "native-tools", "text-tools"] as const)
      expect(report.outcomes[rung]).toMatchObject({ kind: "unknown", fault: "not-attempted" })
    expect(report.choice).toBe("unknown")
  })

  test("🔴 an Anthropic endpoint is not probed with an OpenAI body", async () => {
    // Sending the wrong envelope would measure OUR request, not the endpoint. `not-attempted` WITH
    // the reason is the honest answer.
    const { report, sent } = await run([], { authStyle: "anthropic" })
    expect(sent).toHaveLength(0)
    expect(report.outcomes["native-tools"]).toMatchObject({ kind: "unknown", fault: "not-attempted" })
    expect(report.outcomes["native-tools"].kind === "unknown" && report.outcomes["native-tools"].detail).toContain(
      "chat-completions",
    )
  })
})
