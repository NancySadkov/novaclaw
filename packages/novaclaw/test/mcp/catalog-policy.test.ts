import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
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
})
