import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"

// Provider-import presets: the builtin catalog's shape and the field-wise override merge that
// makes endpoints repairable at runtime (self-healing — a PATCH /config {"provider_presets":…}
// must fix ONE field without losing the rest of the builtin).
//
// 🔴 **This file used to POSITIVELY PIN five branded public-cloud presets** — it asserted the ids
// `["anthropic","deepseek","moonshot","openai","zai"]`, that each had a parseable vendor `baseURL`
// and a parseable commercial `keyURL`, and that overrides preserved them. So the catalog that broke
// the product's central promise was not merely shipped: it was ratcheted, and any attempt to remove
// it would have failed here and read like a regression. That is the shape worth naming — a test can
// hold a defect in place as firmly as it holds a property (Codex review NC-SEC-014).
//
// The direction is now inverted. Nothing here asserts WHICH presets ship; it asserts that whatever
// ships carries no public destination and no commercial key link.

describe("ConfigProviderPreset", () => {
  /**
   * 🔴 The ratchet. AGENTS.md: *"runs entirely against local models: no paid APIs, and your data
   * never egresses"*, and design principle 4. A built-in preset is a first-party offer, so a public
   * `baseURL` in this record is the product shipping the mode it forbids.
   *
   * ⚠️ It screens by HOST, not by brand name. "Reject anything containing 'openai'" would pass an
   * `api.some-vendor.example` entry and fail a user's own `openai-compatible` box on the LAN — the
   * publisher's brand is not the test (ruling 10), the destination is.
   */
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"])
  const isLocal = (host: string) =>
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".local") ||
    // RFC1918 / link-local / CGNAT — the "your own machine or your own network" set.
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)

  it("🔴 ships NO public-cloud destination and NO commercial key link", () => {
    for (const [id, preset] of Object.entries(ConfigProviderPreset.BUILTINS)) {
      expect(
        preset.keyURL,
        `built-in preset "${id}" links the user to buy an API key. NovaClaw does not ship a paid-API path (AGENTS.md, design principle 4).`,
      ).toBeUndefined()
      if (preset.baseURL === undefined) continue
      const host = new URL(preset.baseURL).hostname
      expect(
        isLocal(host),
        `built-in preset "${id}" points the session data plane at ${host}. A built-in is a first-party offer, and the data plane never egresses (AGENTS.md, design principle 4).`,
      ).toBe(true)
    }
  })

  // The NEGATIVE control for the ratchet above: it must actually be able to FAIL. A screen that
  // accepts everything would pass the assertion loop on an empty record forever and prove nothing.
  it("the ratchet's own screen rejects a public host and accepts a local one", () => {
    expect(isLocal(new URL("https://api.openai.com/v1").hostname)).toBe(false)
    expect(isLocal(new URL("https://api.z.ai/api/paas/v4").hostname)).toBe(false)
    expect(isLocal(new URL("http://localhost:8000/v1").hostname)).toBe(true)
    expect(isLocal(new URL("http://10.0.0.5:8000/v1").hostname)).toBe(true)
    expect(isLocal(new URL("http://spark.local:8020/v1").hostname)).toBe(true)
  })

  it("effective() with no overrides returns the builtins", () => {
    expect(ConfigProviderPreset.effective()).toEqual(ConfigProviderPreset.BUILTINS)
    expect(ConfigProviderPreset.effective({})).toEqual(ConfigProviderPreset.BUILTINS)
  })

  /**
   * Self-healing is the half most at risk of being broken by the deletion: a `{baseURL}` fix must
   * still replace ONE field and lose nothing else.
   *
   * ⚠️ **This seeds a builtin on purpose, and says so rather than letting the reader assume one
   * ships.** `effective()`'s field-wise merge is `builtins ⊕ overrides` per id, so with the record
   * now empty the merge arm has nothing left in production to exercise — an override simply becomes
   * the whole entry (the case below this one). Deleting this test with the presets would have
   * silently retired a live code path: the arm still runs the moment anyone adds a LOCAL builtin,
   * and a repair that clobbered the rest of the entry is exactly the self-healing failure the
   * comment on `BUILTINS` promises against. Restored in `finally` so no other test inherits it.
   */
  it("merges an override field-wise: a baseURL fix keeps the rest of the entry", () => {
    const seeded = ConfigProviderPreset.Info.make({
      name: "Spark",
      keyURL: "http://10.0.0.5:8000/keys",
      baseURL: "http://10.0.0.5:8000/v1",
      api: "@ai-sdk/openai-compatible" as const,
      authStyle: "bearer" as const,
    })
    ConfigProviderPreset.BUILTINS["lan"] = seeded
    try {
      const merged = ConfigProviderPreset.effective({
        lan: ConfigProviderPreset.Info.make({ baseURL: "http://10.0.0.9:8000/v1" }),
      })
      expect(merged.lan?.baseURL).toBe("http://10.0.0.9:8000/v1")
      expect(merged.lan?.name).toBe("Spark")
      expect(merged.lan?.keyURL).toBe("http://10.0.0.5:8000/keys")
      expect(merged.lan?.api).toBe("@ai-sdk/openai-compatible")
      expect(merged.lan?.authStyle).toBe("bearer")
    } finally {
      delete ConfigProviderPreset.BUILTINS["lan"]
    }
    expect(Object.keys(ConfigProviderPreset.BUILTINS)).not.toContain("lan")
  })

  it("adds unknown ids as new presets and carries hidden through", () => {
    const merged = ConfigProviderPreset.effective({
      myproxy: ConfigProviderPreset.Info.make({ name: "My proxy", baseURL: "http://10.0.0.5:8000/v1" }),
      myproxy2: ConfigProviderPreset.Info.make({ name: "Second proxy", hidden: true }),
    })
    expect(merged.myproxy?.name).toBe("My proxy")
    expect(merged.myproxy?.baseURL).toBe("http://10.0.0.5:8000/v1")
    expect(merged.myproxy2?.hidden).toBe(true)
    expect(merged.myproxy2?.name).toBe("Second proxy")
  })

  it("decodes a sparse config fragment and rejects an out-of-set API channel", () => {
    const decoded = Schema.decodeUnknownSync(ConfigProviderPreset.Info)({ baseURL: "https://x.example/v1" })
    expect(decoded.baseURL).toBe("https://x.example/v1")
    expect(decoded.name).toBeUndefined()
    // The closed adapter set is baked into the schema: a runtime "fix" can never invent a
    // fourth channel (no vendor npm ever loads by name).
    expect(() => Schema.decodeUnknownSync(ConfigProviderPreset.Info)({ api: "@ai-sdk/some-vendor" })).toThrow()
  })
})
