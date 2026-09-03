import { describe, expect, test } from "bun:test"
import { describeRuntimeStatus } from "@novaclaw/core/kb-graph/memory"

/**
 * `WasmMemory.publishBlocked` is set on every failed checkpoint and cleared on the next success.
 * Until 2026-09-03 nothing read it: `runtimeStatus()` was computed once at open, so a store whose
 * durable writes had stopped landing reported `ready` with no detail, nova-health said healthy, and
 * the memories the user kept writing existed only in MEMFS until the next restart lost them. The
 * composition is pure so this can pin it without a WASM engine.
 */
describe("memory runtime status carries the blocked-writes reason", () => {
  test("🔴 a ready store with a blocked checkpoint says so in detail", () => {
    expect(describeRuntimeStatus({ stage: "ready" }, "IO error: disk full")).toEqual({
      stage: "ready",
      detail: "durable writes blocked: IO error: disk full",
    })
  })
  test("an existing detail (a recovered open) is kept, and the reason appended", () => {
    expect(describeRuntimeStatus({ stage: "ready", detail: "recovered: opened gen-3" }, "boom")).toEqual({
      stage: "ready",
      detail: "recovered: opened gen-3; durable writes blocked: boom",
    })
  })
  test("nothing blocked, or not ready: the status passes through untouched", () => {
    const ready = { stage: "ready" as const }
    expect(describeRuntimeStatus(ready, undefined)).toBe(ready)
    const loading = { stage: "loading" as const }
    expect(describeRuntimeStatus(loading, "boom")).toBe(loading)
    const error = { stage: "error" as const, detail: "open failed" }
    expect(describeRuntimeStatus(error, "boom")).toBe(error)
  })
})
