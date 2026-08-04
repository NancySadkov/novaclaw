import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Logger } from "effect"
import { McpCatalog } from "../../src/mcp/catalog"

const definition = {
  name: "policy_probe",
  inputSchema: { type: "object", properties: {} },
} as MCPToolDef

const executeWith = async (timeout?: number) => {
  const requests: Array<{ timeout?: number }> = []
  const client = {
    callTool: async (_input: unknown, _schema: unknown, options: { timeout?: number }) => {
      requests.push(options)
      return { isError: false, content: [{ type: "text" as const, text: "ok" }] }
    },
  } as unknown as Client
  const tool = McpCatalog.convertTool(definition, client, timeout)
  await tool.execute!({}, { toolCallId: "policy-probe", messages: [] })
  return requests[0]?.timeout
}

describe("MCP tool callout policy", () => {
  test("the declared default and per-server timeout reach the SDK call", async () => {
    expect(await executeWith()).toBe(30_000)
    expect(await executeWith(12_345)).toBe(12_345)
  })

  test("an unsafe direct timeout cannot disable the request ceiling", async () => {
    expect(await executeWith(Number.NaN)).toBe(30_000)
    expect(await executeWith(-1)).toBe(1)
  })

  test("catalog failures emit a stable key with the dynamic catalog and fault as attributes", async () => {
    const records: unknown[][] = []
    const collector = Logger.make((options: Logger.Options<unknown>) => {
      if (options.logLevel !== "Warn") return
      records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
    })

    const result = await Effect.runPromise(
      McpCatalog.fetch(
        "docs-server",
        {} as Client,
        async () => {
          throw new Error("catalog offline")
        },
        "resource templates",
      ).pipe(Effect.provide(Logger.layer([collector]))),
    )

    expect(result).toBeUndefined()
    expect(records).toEqual([
      [
        { event: "mcp.catalog.list.failed" },
        "failed to get MCP catalog entries",
        {
          server: "docs-server",
          "mcp.catalog": "resource templates",
          "mcp.error": "catalog offline",
        },
      ],
    ])
  })
})
