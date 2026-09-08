import { describe, expect, test } from "bun:test"

import { boundedMcpFetch, McpResponseTooLarge } from "./bounded-fetch"

const body = (bytes: number, type = "application/json") =>
  new Response(new Uint8Array(bytes).fill(65), { headers: { "content-type": type } })

/**
 * 🔴 NC-SEC-008 — the MCP transports were handed a URL, an auth provider and headers, and no size
 * policy at all. A configured server could return a body of any length and the host accumulated and
 * parsed all of it.
 *
 * A/B: delete the `total > cap` throw and "refuses an oversized JSON body" fails; delete the
 * `text/event-stream` passthrough and "an SSE stream is never bounded" fails.
 */
describe("the MCP bounded fetch", () => {
  test("🔴 refuses an oversized JSON body instead of truncating it", async () => {
    // Truncation is wrong for a PROTOCOL: half a JSON-RPC message is broken, not smaller.
    const fetchBounded = boundedMcpFetch(100, async () => body(500))
    expect(fetchBounded("https://mcp.example/rpc")).rejects.toBeInstanceOf(McpResponseTooLarge)
  })

  test("🔴 an SSE stream is NEVER bounded — it is long-lived by design", async () => {
    // A connection ceiling here would kill real sessions exactly when they became useful.
    const fetchBounded = boundedMcpFetch(100, async () => body(500, "text/event-stream"))
    const response = await fetchBounded("https://mcp.example/sse")
    expect(response.status).toBe(200)
  })

  test("a body under the cap passes through with its status and headers", async () => {
    // The control: without it, "always throw" would satisfy the first test.
    const fetchBounded = boundedMcpFetch(1_000, async () => body(50))
    const response = await fetchBounded("https://mcp.example/rpc")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect((await response.arrayBuffer()).byteLength).toBe(50)
  })

  test("a bodyless response is not a failure", async () => {
    const fetchBounded = boundedMcpFetch(10, async () => new Response(null, { status: 204 }))
    expect((await fetchBounded("https://mcp.example/rpc")).status).toBe(204)
  })
})
