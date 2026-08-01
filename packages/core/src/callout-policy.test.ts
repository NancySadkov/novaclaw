import { describe, expect, test } from "bun:test"
import { CalloutPolicy } from "./callout-policy"

describe("owned callout policy audit", () => {
  test("every owned family declares the complete vocabulary", () => {
    expect(Object.keys(CalloutPolicy.AUDIT).sort()).toEqual([
      "mcp_tool",
      "quality_gate",
      "summarizer",
      "telemetry_logs",
      "telemetry_traces",
      "webfetch",
      "websearch",
    ])
    for (const policy of Object.values(CalloutPolicy.AUDIT)) {
      expect(Object.keys(policy).sort()).toEqual([
        "failureMode",
        "maxConcurrency",
        "mode",
        "queueLimit",
        "retries",
        "retryDelayMs",
        "timeoutMs",
      ])
      expect(policy.timeoutMs).toBeGreaterThan(0)
      expect(policy.retries).toBeGreaterThanOrEqual(0)
      expect(policy.retryDelayMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("failure stances match the caller-visible behavior", () => {
    expect(CalloutPolicy.DEFAULT_FAILURE_MODE).toBe("fail_closed")
    expect(CalloutPolicy.AUDIT.mcp_tool.failureMode).toBe("fail_closed")
    expect(CalloutPolicy.AUDIT.webfetch.failureMode).toBe("fail_closed")
    expect(CalloutPolicy.AUDIT.quality_gate.failureMode).toBe("fail_closed")
    expect(CalloutPolicy.AUDIT.websearch.failureMode).toBe("fail_open")
    expect(CalloutPolicy.AUDIT.telemetry_logs.failureMode).toBe("fail_open")
    expect(CalloutPolicy.AUDIT.telemetry_traces.failureMode).toBe("fail_open")
    expect(CalloutPolicy.AUDIT.summarizer.failureMode).toBe("fail_open")
  })

  test("runtime-provided bounds are made finite and usable", () => {
    expect(CalloutPolicy.mcpTool(Number.NaN).timeoutMs).toBe(30_000)
    expect(CalloutPolicy.mcpTool(Number.MAX_SAFE_INTEGER).timeoutMs).toBe(2_147_483_647)
    expect(CalloutPolicy.websearch(-50, 0)).toMatchObject({ timeoutMs: 1, maxConcurrency: 1 })
    expect(CalloutPolicy.qualityGate(9_999.9).timeoutMs).toBe(9_999)
    expect(CalloutPolicy.telemetryTraces(Number.POSITIVE_INFINITY, -1)).toMatchObject({
      timeoutMs: 30_000,
      queueLimit: 1,
    })
  })
})
