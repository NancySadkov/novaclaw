import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { monitor, probe, probeURLFromListenLine, requestStop } from "./serve-liveness"

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

  /**
   * 🔴 NC-REL-003 — a password set in the SETTINGS STORE made the default `novaclaw serve` supervisor
   * kill its own healthy child. The probe is handed only `NOVACLAW_SERVER_PASSWORD`, so a
   * store-configured password produced a 401, `response.ok` was false, the check counted as a miss,
   * and the supervisor terminated a server that was working perfectly — then did it again until it
   * gave up. The one configuration a user can set through the product bricked headless serving.
   *
   * A/B: revert to `return response.ok` and this fails.
   */
  test("🔴 a 401 is PROOF OF LIFE, not a missed health check", async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch
      expect(await probe(new URL("http://127.0.0.1:4096/api/health"))).toBe(true)
      globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch
      expect(await probe(new URL("http://127.0.0.1:4096/api/health"))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  test("a 500 is still a miss — the server answered, but not with health", async () => {
    // The control: without it, "always true" would satisfy the test above and the supervisor would
    // never replace a genuinely broken child.
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
      expect(await probe(new URL("http://127.0.0.1:4096/api/health"))).toBe(false)
    } finally {
      globalThis.fetch = original
    }
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

describe("requestStop — the supervisor asks before it kills", () => {
  /**
   * 🔴 The defect: the supervisor's ONLY stop was a tree-kill, and on Windows that is
   * `TerminateProcess` — the child's signal handlers, and so its whole `Shutdown.settleAll`, never
   * ran. Every supervised stop discarded whatever was mid-flush. These drive a real loopback server
   * rather than asserting on source, because what matters is the request that actually goes out.
   */
  const serve = (handler: (request: Request) => Response) => {
    const server = Bun.serve({ port: 0, fetch: handler })
    const url = new URL(`http://127.0.0.1:${server.port}/global/health`)
    return { server, url }
  }

  test("POSTs to /global/dispose with basic auth, and reports the child released", async () => {
    let seen: { method: string; path: string; auth: string | null } | undefined
    const { server, url } = serve((request) => {
      const parsed = new URL(request.url)
      seen = { method: request.method, path: parsed.pathname, auth: request.headers.get("authorization") }
      return new Response("true", { status: 200 })
    })
    try {
      expect(await requestStop(url, "hunter2")).toBe(true)
      // The health URL is REWRITTEN, not appended to — a stop sent to /global/health would answer
      // 200 and release nothing, which is the failure this pins.
      expect(seen?.path).toBe("/global/dispose")
      expect(seen?.method).toBe("POST")
      expect(seen?.auth).toBe(`Basic ${Buffer.from("novaclaw:hunter2").toString("base64")}`)
    } finally {
      server.stop(true)
    }
  })

  test("omits the header when no password is set, rather than sending an empty credential", async () => {
    let auth: string | null | undefined
    const { server, url } = serve((request) => {
      auth = request.headers.get("authorization")
      return new Response("true")
    })
    try {
      await requestStop(url)
      expect(auth).toBeNull()
    } finally {
      server.stop(true)
    }
  })

  test("a refusal is reported, never thrown — the kill must still follow", async () => {
    const { server, url } = serve(() => new Response("nope", { status: 401 }))
    try {
      expect(await requestStop(url, "wrong")).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("an unreachable child resolves false instead of rejecting", async () => {
    // Nothing is listening here. If this rejected, the supervisor's `finally` would still exit but
    // the unhandled rejection would be the last thing a user saw on an ordinary Ctrl+C.
    const dead = new URL("http://127.0.0.1:1/global/health")
    expect(await requestStop(dead, "x")).toBe(false)
  })
})
