import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderReach } from "@novaclaw/core/provider-reach"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const answering =
  (status = 200) =>
  async () => ({ ok: status < 400, status })
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

describe("which provider the board speaks for", () => {
  const presets = { deepseek: { baseURL: "https://api.deepseek.com/v1" }, named: {} }

  test("names the provider behind the default model, with its address", () => {
    expect(ProviderReach.targetOf({ model: "deepseek/deepseek-chat", presets })).toEqual({
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
    })
  })

  test("splits on the FIRST slash, because a model id may contain more", () => {
    // `nvidia/Qwen3.6-35B-A3B-NVFP4` is a real id shape. Splitting on the last slash would name a
    // provider that does not exist and then report the user's working setup unreachable.
    expect(ProviderReach.targetOf({ model: "nvidia/Qwen3.6-35B/A3B", presets })?.name).toBe("nvidia")
  })

  test("a provider with no configured address is named but not probeable", () => {
    expect(ProviderReach.targetOf({ model: "named/some-model", presets })).toEqual({ name: "named" })
  })

  /**
   * ⚠️ The regression this pair exists for. Reading `provider_presets` ALONE reported "No address is
   * configured for this provider" about a live, actively-used provider — a false description on the
   * one screen someone opens to find out what is wrong. A user's own provider carries its address at
   * `providers[id].api.url`, which is where turns are actually sent; presets only describe builtins.
   */
  test("a user-configured provider is found by its api.url, not just by presets", () => {
    expect(
      ProviderReach.targetOf({
        model: "spark-holo/holo3.1",
        providers: { "spark-holo": { api: { url: "http://spark-0693.local:8010/v1" } } },
        presets,
      }),
    ).toEqual({ name: "spark-holo", baseURL: "http://spark-0693.local:8010/v1" })
  })

  test("the configured address WINS over a preset of the same name", () => {
    // The preset is a default for the import flow; what the user set is what turns actually use, so
    // probing the preset would test an endpoint this instance never talks to.
    expect(
      ProviderReach.targetOf({
        model: "deepseek/deepseek-chat",
        providers: { deepseek: { api: { url: "http://my-proxy.local/v1" } } },
        presets,
      })?.baseURL,
    ).toBe("http://my-proxy.local/v1")
  })

  /**
   * ⚠️ THE case worth the test. A user who has chosen no model has no provider to be warned about,
   * and a row saying "unknown" would put a worry on the health board that the rest of the product
   * does not share — inventing a concern is the same defect as hiding one.
   */
  test("no default model yields NO row rather than a row about nothing", () => {
    expect(ProviderReach.targetOf({ model: undefined, presets })).toBeUndefined()
    expect(ProviderReach.targetOf({ model: "   ", presets })).toBeUndefined()
    expect(ProviderReach.targetOf({ model: "/orphan", presets })).toBeUndefined()
  })

  test("an empty configured address is treated as absent, not as a URL", () => {
    expect(ProviderReach.targetOf({ model: "blank/m", presets: { blank: { baseURL: "" } } })).toEqual({
      name: "blank",
    })
  })
})
