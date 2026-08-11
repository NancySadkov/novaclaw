import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderReach } from "@novaclaw/core/provider-reach"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const answering = (status = 200) => async () => ({ ok: status < 400, status })
const throwing = (error: unknown) => async () => {
  throw error
}

describe("provider reachability", () => {
  test("an answering endpoint is ok, with a round trip", async () => {
    let clock = 1000
    const reach = await run(
      ProviderReach.probe({
        url: "https://api.example.test/v1",
        fetcher: answering(),
        now: () => (clock += 40),
      }),
    )
    expect(reach.verdict).toBe("ok")
    expect(reach.ms).toBeGreaterThan(0)
  })

  // ⚠️ A 401 is the endpoint DECLINING to serve us — a credential problem, not the network being
  // down. A reachability probe that relabelled it "unreachable" would send someone hunting a
  // connection fault over a wrong API key.
  test("a 401 or 404 is still REACHABLE", async () => {
    for (const status of [401, 403, 404, 500]) {
      const reach = await run(ProviderReach.probe({ url: "https://x.test", fetcher: answering(status) }))
      expect(reach.verdict).toBe("ok")
    }
  })

  test("a transport failure is unreachable, and says what happened", async () => {
    const reach = await run(
      ProviderReach.probe({ url: "https://x.test", fetcher: throwing(new Error("ECONNREFUSED")) }),
    )
    expect(reach.verdict).toBe("unreachable")
    expect(reach.detail).toContain("ECONNREFUSED")
  })

  // 🔴 The distinction this module exists to keep. `offline.ts` smuggles an `EgressBlocked` marker
  // through the cause precisely so a policy verdict never reads as a broken endpoint; collapsing it
  // into "unreachable" here would undo that at the last step — and tell a user their provider is
  // down when the truth is that they turned the airgap on.
  test("an airgap block is BLOCKED, never unreachable", async () => {
    const blocked = await run(
      ProviderReach.probe({ url: "https://x.test", fetcher: throwing(new Error("EgressBlocked: host not allowed")) }),
    )
    expect(blocked.verdict).toBe("blocked")
    expect(blocked.detail).toContain("offline mode")
  })

  test("a timeout is unreachable and names the budget", async () => {
    const reach = await run(
      ProviderReach.probe({
        url: "https://slow.test",
        timeoutMs: 10,
        fetcher: (_url, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }),
    )
    expect(reach.verdict).toBe("unreachable")
    expect(reach.detail).toContain("10 ms")
  })
})

describe("blockedByPolicy — answer from the policy, do not spend a request to learn it", () => {
  const policy = (enabled: boolean, hosts: string[] = []) => ({ enabled, allowedHosts: new Set(hosts) })

  test("nothing is blocked with the airgap off", () => {
    expect(ProviderReach.blockedByPolicy(policy(false), "https://api.openai.test/v1")).toBe(false)
  })

  test("a WAN host is blocked with the airgap on", () => {
    expect(ProviderReach.blockedByPolicy(policy(true), "https://api.openai.test/v1")).toBe(true)
  })

  test("an allow-listed host is not blocked", () => {
    expect(ProviderReach.blockedByPolicy(policy(true, ["searx.lan"]), "https://searx.lan/search")).toBe(false)
  })

  // ⚠️ `Offline`'s own rule: the app talking to itself is not egress, the airgap threat model is the
  // WAN. A local model server must stay probeable with the WAN sealed, or the health screen goes
  // dark exactly for the users who are most local-first.
  test("loopback is never blocked, even sealed", () => {
    for (const url of ["http://localhost:8010/v1", "http://127.0.0.1:4096/health", "http://[::1]:3000/"])
      expect(ProviderReach.blockedByPolicy(policy(true), url)).toBe(false)
  })
})
