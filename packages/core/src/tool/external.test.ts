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
        Effect.succeed({ structured: null, content: [{ type: "file", data: "AAA", mime: "image/png", name: "x.png" }] }),
    })
    const out: any = await Effect.runPromise(Tool.settle(tool, call({}), ctx) as any)
    expect(out.content).toEqual([{ type: "file", uri: "data:image/png;base64,AAA", mime: "image/png", name: "x.png" }])
  })

  test("permission override is honored, else defaults to the tool name", () => {
    const withPerm = Tool.makeExternal({
      description: "d",
      inputSchema: {} as any,
      permission: "mcp",
      execute: () => Effect.succeed({ structured: null, content: [] }),
    })
    const noPerm = Tool.makeExternal({ description: "d", inputSchema: {} as any, execute: () => Effect.succeed({ structured: null, content: [] }) })
    expect(Tool.permission(withPerm, "searxng_search")).toBe("mcp")
    expect(Tool.permission(noPerm, "searxng_search")).toBe("searxng_search")
  })
})
