import { describe, expect, test } from "bun:test"
import { Logging } from "@novaclaw/core/observability/logging"
import { Effect, Logger, References } from "effect"
import { serverLog } from "../../src/mcp/index"

const lineFor = (level: "debug" | "emergency", data: unknown): string => {
  const lines: string[] = []
  const capture = Logger.map(Logging.formatter("mcp-test"), (line) => lines.push(line))
  Effect.runSync(
    serverLog("foreign-server", { level, data }).pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Info"),
    ),
  )
  expect(lines).toHaveLength(1)
  return lines[0]!
}

describe("MCP server log relay", () => {
  test("foreign severity is an attribute and never promotes our severity", () => {
    for (const foreign of ["debug", "emergency"] as const) {
      const line = lineFor(foreign, { answer: 42 })
      expect(line).toContain("level=INFO")
      expect(line).toContain("event=mcp.server.output")
      expect(line).toContain(`mcp.level=${foreign}`)
      expect(line).toContain("server=foreign-server")
      expect(line).toContain("answer")
      expect(line.match(/(?:^| )level=/g) ?? []).toHaveLength(1)
    }
  })
})
