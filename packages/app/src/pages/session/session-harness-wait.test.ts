import { describe, expect, test } from "bun:test"
import { harnessWaitLabel } from "./session-harness-wait"

const attempt = (phase: "drain" | "provider" | "tool" | "maintenance", toolName?: string) => ({
  state: "busy",
  phase,
  toolName,
  toolState: "dispatched" as const,
})

describe("durable harness wait taxonomy", () => {
  test("the generic line is reserved for genuinely unknown harness work", () => {
    expect(harnessWaitLabel(undefined)).toBe("Waiting for the harness…")
    expect(harnessWaitLabel(attempt("drain"))).toBe("Waiting for the harness…")
  })

  test("names model, shell, file, thread, maintenance, and reconciliation waits", () => {
    expect(harnessWaitLabel(attempt("provider"))).toBe("Waiting for the model…")
    expect(harnessWaitLabel(attempt("tool", "bash"))).toBe("Waiting for a shell command…")
    expect(harnessWaitLabel(attempt("tool", "read"))).toBe("Waiting for file access…")
    expect(harnessWaitLabel(attempt("tool", "colleague"))).toBe("Syncing with another thread…")
    expect(harnessWaitLabel(attempt("maintenance"))).toBe("Waiting for maintenance…")
    expect(harnessWaitLabel(attempt("drain"), { transcriptReconciliation: true })).toBe("Syncing the transcript…")
  })

  test("preserves an unknown tool's logged name rather than flattening it", () => {
    expect(harnessWaitLabel(attempt("tool", "community"))).toBe("Waiting for community…")
    expect(harnessWaitLabel({ ...attempt("tool", "websearch"), toolSideEffect: "read" })).toBe("Waiting for websearch…")
  })
})
