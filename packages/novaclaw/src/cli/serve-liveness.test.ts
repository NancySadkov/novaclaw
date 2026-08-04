import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { monitor, probeURLFromListenLine } from "./serve-liveness"

describe("serve liveness", () => {
  test("parses the real listen line and probes wildcard listeners through loopback", () => {
    expect(probeURLFromListenLine("unrelated output")).toBeUndefined()
    expect(probeURLFromListenLine("novaclaw server listening on http://127.0.0.1:4096")?.href).toBe(
      "http://127.0.0.1:4096/global/health",
    )
    expect(probeURLFromListenLine("novaclaw server listening on http://0.0.0.0:5000")?.href).toBe(
      "http://127.0.0.1:5000/global/health",
    )
  })

  test("kills only after consecutive misses", async () => {
    const outcomes = [false, true, false, false, false]
    const failures: number[] = []
    await monitor({
      signal: new AbortController().signal,
      check: async () => outcomes.shift() ?? true,
      wait: async () => undefined,
      onUnresponsive: (count) => failures.push(count),
    })
    expect(failures).toEqual([3])
  })

  test("abort ends a monitor without reporting an outage", async () => {
    const abort = new AbortController()
    const failures: number[] = []
    await monitor({
      signal: abort.signal,
      check: async () => false,
      wait: async () => abort.abort(),
      onUnresponsive: (count) => failures.push(count),
    })
    expect(failures).toEqual([])
  })

  test("both shipped supervisors wire failed liveness to process replacement", () => {
    const serve = fs.readFileSync(path.join(import.meta.dir, "cmd", "serve.ts"), "utf8")
    const desktop = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "..", "desktop", "src", "main", "server.ts"),
      "utf8",
    )
    expect(serve).toContain('stdout: "pipe"')
    expect(serve).toContain("ServeLiveness.monitor({")
    expect(serve).toContain("treeKill(child)")
    expect(desktop).toContain("livenessDecision(livenessFailures, await checkHealth(")
    expect(desktop).toContain("handle.listener.terminate()")
  })
})
