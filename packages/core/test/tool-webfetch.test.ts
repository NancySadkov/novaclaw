import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { WebFetchTool } from "@novaclaw/core/tool/webfetch"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: PermissionV2.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
/**
 * Set to make the permission gate fail. ⚠️ `assert`'s error channel is
 * `PermissionV2.Error | SessionV2.NotFoundError` — and `PermissionV2.Error` is the module's own
 * union (`DeniedError | RejectedError | CorrectedError`), NOT the global `Error`. `denialMessage`
 * answers all three of those, so `NotFoundError` is the only member it declines, which makes it the
 * one honest negative control available here.
 */
let assertFailure: PermissionV2.Error | SessionV2.NotFoundError | undefined

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.gen(function* () {
        assertions.push(input)
        // No `return` — returning the failed effect widens the success channel to `undefined`,
        // which is not assignable to the interface's `Effect<void, …>`.
        if (assertFailure) yield* Effect.fail(assertFailure)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ...replacements,
  ])
const it = testEffect(toolLayer([[LayerNodePlatform.httpClient, http]]))
const live = testEffect(toolLayer())

const reset = () => {
  requests.length = 0
  assertions.length = 0
  assertFailure = undefined
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch"])
      // The model-facing halves carry the untrusted-content frame; the STORED `structured.output`
      // does not. Expressed through the projection rather than as a literal so the wording lives in
      // exactly one place (`test/untrusted-framing.test.ts` pins the wording itself).
      const framed = WebFetchTool.toModelOutput({ url, output: "hello" })
      expect(yield* settleTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        result: { type: "text", value: framed },
        output: {
          structured: { url, contentType: "text/plain", format: "text", output: "hello" },
          content: [{ type: "text", text: framed }],
        },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text", timeout: 4 } },
      ])
      expect(requests).toMatchObject([{ url, headers: { accept: expect.stringContaining("text/plain;q=1.0") } }])
    }),
  )

  it.effect("accepts localhost URLs with the same requested-URL permission check", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://localhost/private"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "text",
        value: WebFetchTool.toModelOutput({ url, output: "hello" }),
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
      ])
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  live.effect("follows redirects while approving only the requested URL", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === "/redirect"
              ? new Response("", { status: 302, headers: { location: "/target" } })
              : new Response("redirected", { headers: { "content-type": "text/plain" } }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          reset()
          const registry = yield* ToolRegistry.Service
          const url = new URL("/redirect", server.url).toString()

          expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
            type: "text",
            // Through the projection, not a literal: the frame names the HOST and this server's port
            // is assigned at boot, so a literal would be unwritable here.
            value: WebFetchTool.toModelOutput({ url, output: "redirected" }),
          })
          expect(assertions).toMatchObject([
            { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch file:///etc/passwd",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }))).toEqual({
        type: "text",
        value: WebFetchTool.toModelOutput({ url: "https://1.1.1.1", output: "# Hello\n\nworld" }),
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: WebFetchTool.toModelOutput({ url: "https://1.1.1.1", output: "Helloworld" }),
      })
    }),
  )

  it.effect("returns an error result when HTML-to-Markdown conversion throws", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/declared",
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/streamed",
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed settlement can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/image",
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/file",
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: WebFetchTool.toModelOutput({ url: "https://1.1.1.1", output: "ok" }),
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toContain("Mozilla/5.0")
      expect(requests[1]?.headers["user-agent"]).toBe("novaclaw")
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "error", value: "Unable to fetch https://1.1.1.1/slow" })
    }),
  )

  // The blanket `mapError` used to ignore its error, so a permission verdict reached the model as
  // "Unable to fetch <url>" — indistinguishable from a network fault, and therefore worth retrying.
  // Since B4c `webfetch` falls through to `ask`, and an unattended root deny-fasts with
  // `unattended-unanswerable`, whose text exists precisely to stop the retry loop.
  it.effect("a permission denial keeps its own text instead of collapsing into the fetch fallback", () =>
    Effect.gen(function* () {
      reset()
      const url = "https://1.1.1.1/gated"
      const denial = new PermissionV2.DeniedError({
        rules: [{ action: "webfetch", resource: url, effect: "deny" }],
        reason: "unattended-unanswerable",
      })
      assertFailure = denial
      const registry = yield* ToolRegistry.Service

      const expected = PermissionV2.denialMessage(denial)
      // Guard the instrument: if `denialMessage` ever returned undefined or the fallback wording,
      // the assertion below would pass while proving nothing.
      expect(typeof expected).toBe("string")
      expect(expected).not.toBe(`Unable to fetch ${url}`)
      expect(expected).toContain("webfetch")

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "error",
        value: expected,
      })
    }),
  )

  it.effect("NEGATIVE CONTROL: a non-permission failure still gets the fetch fallback", () =>
    Effect.gen(function* () {
      reset()
      // A vanished session, not a denial — `denialMessage` declines it, so the else arm must still
      // answer. This is the case a blanket "Permission denied" absorber gets actively WRONG.
      assertFailure = new SessionV2.NotFoundError({ sessionID })
      const registry = yield* ToolRegistry.Service

      expect(PermissionV2.denialMessage(assertFailure)).toBeUndefined()
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/ungated", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/ungated",
      })
    }),
  )
})
