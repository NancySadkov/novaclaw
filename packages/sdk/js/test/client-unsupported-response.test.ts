import { describe, expect, test } from "bun:test"
import { createNovaclawClient, UnsupportedRequestError } from "../src/v2/client"

/**
 * Lives in `test/`, not beside `client.ts`, for the reason `client-directory-header.test.ts` gives:
 * `src` is browser-facing and must not gain the Bun global.
 *
 * A server that answers an API call with a page (an older build without the route, a proxy's own
 * error page) is a case a caller may want to IGNORE — the terminal does. That decision has to be
 * made on a class, not on the wording of a sentence: the one caller used to test
 * `message.includes("Request is not supported")`, so rewording the message here would have turned
 * its quiet fallback into a thrown error. This pins the class, and that the message still carries
 * what came back.
 */
describe("a page instead of a body", () => {
  test("🔴 rejects with UnsupportedRequestError, through a real generated call", async () => {
    const client = createNovaclawClient({
      baseUrl: "http://localhost:4096",
      fetch: async () =>
        new Response("<!doctype html><title>404</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    } as never)
    const outcome = await client.v2.location.get(undefined, { throwOnError: false } as never).then(
      () => "resolved" as const,
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(UnsupportedRequestError)
    expect((outcome as UnsupportedRequestError).contentType).toBe("text/html")
    expect((outcome as Error).message).toContain("text/html")
  })

  test("a JSON body passes the interceptor untouched", async () => {
    const client = createNovaclawClient({
      baseUrl: "http://localhost:4096",
      fetch: async () =>
        new Response(JSON.stringify({ data: { directory: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    } as never)
    await expect(client.v2.location.get(undefined, { throwOnError: false } as never)).resolves.toBeDefined()
  })
})
