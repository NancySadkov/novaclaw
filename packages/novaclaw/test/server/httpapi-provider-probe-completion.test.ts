import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { probeCompletion } from "../../src/server/routes/instance/httpapi/handlers/provider"

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
