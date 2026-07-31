import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpExternal } from "./mcp-external"
import { Tool } from "./tool"

const ctx = { sessionID: "ses", agent: "build", assistantMessageID: "msg", toolCallID: "c1" } as any
const call = (input: unknown) => ({ id: "c1", name: "searxng_search", input }) as any

describe("McpExternal.fromMcpTool", () => {
  test("unwraps the AI-SDK jsonSchema and keeps the description", () => {
    const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    const tool = McpExternal.fromMcpTool({
      description: "Search via SearXNG",
      inputSchema: { jsonSchema: schema },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    })
    const def = Tool.definition("searxng_search", tool)
    expect(def.description).toBe("Search via SearXNG")
    expect(def.inputSchema).toEqual(schema)
  })

  test("runs execute with the parsed args and maps MCP text content", async () => {
    let received: unknown
    const tool = McpExternal.fromMcpTool({
      inputSchema: { jsonSchema: { type: "object" } },
      execute: async (args) => {
        received = args
        return { content: [{ type: "text", text: "2 results" }] }
      },
    })
    const out: any = await Effect.runPromise(Tool.settle(tool, call({ query: "effect" }), ctx) as any)
    expect(received).toEqual({ query: "effect" })
    // A third party's text arrives framed as data (ruling 5's out-of-process half). Referenced, not
    // re-typed — `test/untrusted-framing.test.ts` in `packages/core` pins the wording itself.
    expect(out.content).toEqual([{ type: "text", text: McpExternal.FRAME + "2 results" }])
  })

  test("an MCP error (thrown execute) becomes a ToolFailure, not a crash", async () => {
    const tool = McpExternal.fromMcpTool({
      inputSchema: {},
      execute: async () => {
        throw new Error("mcp server down")
      },
    })
    const exit = await Effect.runPromiseExit(Tool.settle(tool, call({}), ctx) as any)
    expect(exit._tag).toBe("Failure")
  })

  test("falls back to structuredContent as JSON text when there are no content parts", async () => {
    const tool = McpExternal.fromMcpTool({ inputSchema: {}, execute: async () => ({ structuredContent: { hits: 2 } }) })
    const out: any = await Effect.runPromise(Tool.settle(tool, call({}), ctx) as any)
    expect(out.content).toEqual([{ type: "text", text: McpExternal.FRAME + '{"hits":2}' }])
  })
})
