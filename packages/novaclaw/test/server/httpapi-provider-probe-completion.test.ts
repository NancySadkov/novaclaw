import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProviderSession } from "@novaclaw/core/session/runner/provider-session"
import {
  probeCompletion,
  probeCompletionWithAffinity,
} from "../../src/server/routes/instance/httpapi/handlers/provider"

const run = async (authStyle: "bearer" | "anthropic", response: Response) => {
  const seen: string[] = []
  const client = HttpClient.make((request) => {
    seen.push(request.url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })
  const result = await Effect.runPromise(
    probeCompletion(client, { baseURL: "http://model.test/v1", modelID: "served-id", authStyle, headers: {} }),
  )
  return { result, seen }
}

describe("provider completion probe", () => {
  test("uses the OpenAI-compatible generation route and validates choices", async () => {
    const { result, seen } = await run(
      "bearer",
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(seen).toEqual(["http://model.test/v1/chat/completions"])
    expect(result.kind).toBe("ok")
  })

  test("uses Anthropic messages and distinguishes malformed generation from discovery", async () => {
    const { result, seen } = await run(
      "anthropic",
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(seen).toEqual(["http://model.test/v1/messages"])
    expect(result).toMatchObject({
      kind: "failed",
      status: "error",
      detail: expect.stringContaining("response format"),
    })
  })

  test("reports generation authentication separately", async () => {
    const { result } = await run("bearer", new Response("denied", { status: 401 }))
    expect(result).toMatchObject({ kind: "failed", status: "auth", detail: expect.stringContaining("Generation") })
  })
})

/**
 * The Settings Test is the provider caller outside the runner, and it used to send no session header
 * and learn none — so a gateway the runner already knew about still answered the diagnostic with the
 * MissingSessionID 400. These pin the lesson at that second site.
 */
describe("provider completion probe session affinity", () => {
  afterEach(() => ProviderSession.clearAffinity())

  const MISSING = (header: string) =>
    JSON.stringify({
      type: "error",
      error: {
        type: "MissingSessionID",
        message: `Request is missing ${header} and cannot be routed efficiently.`,
      },
    })

  const OK = () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })

  /** An in-memory stand-in for the settings store, the boundary the affinity lesson is filed in. */
  const memorySettings = (initial: Record<string, unknown> = {}) => {
    const rows: Record<string, unknown> = { ...initial }
    return {
      rows,
      all: () => Effect.succeed(rows),
      set: (key: string, value: unknown) => {
        rows[key] = value
        return Effect.void
      },
    }
  }

  const runAffinity = async (responses: Response[], stored?: Record<string, unknown>) => {
    const sent: Headers[] = []
    const client = HttpClient.make((request) => {
      sent.push(new Headers(request.headers))
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, responses[Math.min(sent.length - 1, responses.length - 1)]!),
      )
    })
    const settings = memorySettings(stored)
    const result = await Effect.runPromise(
      probeCompletionWithAffinity(client, {
        baseURL: "http://gateway.test/v1",
        modelID: "served-id",
        authStyle: "bearer",
        headers: { authorization: "Bearer key" },
        settings,
        timeoutMs: 1000,
      }),
    )
    return { result, sent, settings }
  }

  test("learns the named header from a MissingSessionID 400 and retries it once", async () => {
    const { result, sent, settings } = await runAffinity([
      new Response(MISSING("x-acme-session"), { status: 400 }),
      OK(),
    ])
    expect(result.attempts).toBe(2)
    expect(result.probe.kind).toBe("ok")
    expect(result.header).toBe("x-acme-session")
    // The first request carried no session header; the retry carried the named one under the
    // session-less identity, and named this client rather than an SDK default.
    expect(sent[0]?.get("x-acme-session")).toBeNull()
    expect(sent[1]?.get("x-acme-session")).toBe(ProviderSession.SESSIONLESS_ID)
    expect(sent[1]?.get("user-agent")).toMatch(/^novaclaw\//)
    // And the lesson is filed by endpoint, so the runner's next turn starts warm.
    expect(settings.rows["provider_session_affinity"]).toEqual({ "http://gateway.test/v1": "x-acme-session" })
  })

  test("an endpoint already learned sends the header on the first request and needs no retry", async () => {
    const { result, sent } = await runAffinity([OK()], {
      provider_session_affinity: { "http://gateway.test/v1": "x-acme-session" },
    })
    expect(result.attempts).toBe(1)
    expect(result.probe.kind).toBe("ok")
    expect(sent[0]?.get("x-acme-session")).toBe(ProviderSession.SESSIONLESS_ID)
  })

  test("a refusal that is not the session gate is reported, not retried", async () => {
    const { result, sent } = await runAffinity([new Response('unknown field "repetition_penalty"', { status: 400 })])
    expect(result.attempts).toBe(1)
    expect(result.probe).toMatchObject({ kind: "failed", status: "error" })
    expect(sent).toHaveLength(1)
  })

  test("a second MissingSessionID after the named header is reported, not retried again", async () => {
    const { result, sent } = await runAffinity([
      new Response(MISSING("x-acme-session"), { status: 400 }),
      new Response(MISSING("x-acme-session"), { status: 400 }),
    ])
    expect(result.attempts).toBe(2)
    expect(result.probe).toMatchObject({ kind: "failed", status: "error" })
    expect(sent).toHaveLength(2)
  })
})
