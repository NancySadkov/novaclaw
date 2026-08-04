import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Tool } from "./tool"

const ctx = { sessionID: "ses_x", agent: "build", assistantMessageID: "msg_x", toolCallID: "c1" } as any
const call = (input: unknown) => ({ id: "c1", name: "searxng_search", input }) as any

describe("Tool.makeExternal", () => {
  test("definition exposes the raw JSON schema + description (no Effect-schema conversion)", () => {
    const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    const tool = Tool.makeExternal({
      description: "Search the web via SearXNG",
      inputSchema: schema as any,
      execute: () => Effect.succeed({ structured: null, content: [] }),
    })
    const def = Tool.definition("searxng_search", tool)
    expect(def.name).toBe("searxng_search")
    expect(def.description).toBe("Search the web via SearXNG")
    expect(def.inputSchema).toEqual(schema)
  })

  test("settle runs the external execute and maps text content", async () => {
    const tool = Tool.makeExternal({
      description: "d",
      inputSchema: { type: "object" } as any,
      execute: (input) => Effect.succeed({ structured: input, content: [{ type: "text", text: "2 results" }] }),
    })
    const out: any = await Effect.runPromise(Tool.settle(tool, call({ query: "effect" }), ctx) as any)
    expect(out.structured).toEqual({ query: "effect" })
    expect(out.content).toEqual([{ type: "text", text: "2 results" }])
  })

  test("file content is converted to a data URI like core tools", async () => {
    const tool = Tool.makeExternal({
      description: "d",
      inputSchema: {} as any,
      execute: () =>
        Effect.succeed({
          structured: null,
          content: [{ type: "file", data: "AAA", mime: "image/png", name: "x.png" }],
        }),
    })
    const out: any = await Effect.runPromise(Tool.settle(tool, call({}), ctx) as any)
    expect(out.content).toEqual([{ type: "file", uri: "data:image/png;base64,AAA", mime: "image/png", name: "x.png" }])
  })

  test("an external tool is governed by the name it is registered under — there is no override", () => {
    // This test used to pass `permission: "mcp"` and assert the override was honored. That option
    // is deleted (2026-07-29): it had zero production callers, and both dynamic-tool sources gate
    // execution on `action: <the registered name>`, so any override here would have split the
    // horizon filter from the execution gate. The registry-level proof lives in
    // `test/tool-permission-identity.test.ts`; this is the same claim at the unit.
    const tool = Tool.makeExternal({
      description: "d",
      inputSchema: {} as any,
      execute: () => Effect.succeed({ structured: null, content: [] }),
    })
    expect(Tool.permission(tool, "searxng_search")).toBe("searxng_search")
    expect(Tool.permission(tool, "playwright_click")).toBe("playwright_click")
  })
})
