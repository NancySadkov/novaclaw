/**
 * A `fetch` for the MCP transports that refuses an oversized NON-STREAMING response.
 *
 * 🔴 **NC-SEC-008 — remote MCP responses had no byte ceiling at all.** NovaClaw hands the SDK's
 * remote transports a URL, an auth provider and headers, and nothing else: no size policy, no wrapped
 * fetch. One configured integration could return a body of any length and the host would accumulate
 * and parse all of it. An MCP server URL is configuration, not trust — the same line is reached by a
 * typo'd host, a compromised integration, and a correct one.
 *
 * ⚠️ **It FAILS rather than truncates, and that is not a style choice.** These bodies are JSON-RPC. A
 * truncated one is not a smaller answer, it is a syntactically broken message that the client would
 * then try to parse — turning a size problem into a protocol problem. Truncation is right for a
 * diagnostic body (`schema/bounded-stream`); refusal is right for a protocol.
 *
 * ⚠️ **`text/event-stream` is passed through UNTOUCHED, deliberately.** An SSE stream is long-lived by
 * design — that is how MCP streams a response — so a byte ceiling on the connection would kill
 * legitimate sessions at exactly the moment they became useful. The report's own shape is per-MESSAGE
 * bounds: "direct JSON, every SSE event, and stdio frames". This closes the direct-JSON half; bounding
 * individual SSE events needs a framing-aware transform over the body, and stdio frames are a
 * different transport entirely. Both are recorded rather than half-done.
 */

/** Conservative default. An MCP message this large is a fault, not a big answer. */
export const MCP_RESPONSE_CAP_BYTES = 8_000_000

export class McpResponseTooLarge extends Error {
  readonly url: string
  constructor(url: string, cap: number) {
    super(`MCP response from ${url} exceeded ${Math.round(cap / 1_000_000)} MB and was refused`)
    this.name = "McpResponseTooLarge"
    this.url = url
  }
}

type FetchLike = (url: URL | string, init?: RequestInit) => Promise<Response>

export function boundedMcpFetch(cap: number = MCP_RESPONSE_CAP_BYTES, inner: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const response = await inner(url, init)
    const contentType = response.headers.get("content-type") ?? ""
    // Streaming responses are the transport working as intended — see the note above.
    if (contentType.includes("text/event-stream") || response.body === null) return response

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > cap) {
        // ⚠️ Cancel, so the peer stops sending. Without this the refusal costs us the whole body
        // anyway and the ceiling only protects the parser, not the connection.
        await reader.cancel().catch(() => undefined)
        throw new McpResponseTooLarge(String(url), cap)
      }
      chunks.push(value)
    }
    const body = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      body.set(chunk, at)
      at += chunk.length
    }
    // Status, statusText and headers are preserved: the transport still sees the response it expected,
    // only bounded.
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
