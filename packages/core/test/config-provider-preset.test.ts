import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"

// Provider-import presets: the builtin catalog's shape and the field-wise override merge that
// makes endpoints repairable at runtime (self-healing — a PATCH /config {"provider_presets":…}
// must fix ONE field without losing the rest of the builtin).

describe("ConfigProviderPreset", () => {
  it("ships the five builtin presets with valid URLs and in-tree API channels", () => {
    const ids = Object.keys(ConfigProviderPreset.BUILTINS)
    expect(ids.sort()).toEqual(["anthropic", "deepseek", "moonshot", "openai", "zai"])
    for (const preset of Object.values(ConfigProviderPreset.BUILTINS)) {
      expect(preset.name).toBeTruthy()
      expect(() => new URL(preset.baseURL!)).not.toThrow()
      expect(() => new URL(preset.keyURL!)).not.toThrow()
      expect(["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible"]).toContain(preset.api!)
    }
    expect(ConfigProviderPreset.BUILTINS.anthropic.authStyle).toBe("anthropic")
  })

  it("effective() with no overrides returns the builtins", () => {
    expect(ConfigProviderPreset.effective()).toEqual(ConfigProviderPreset.BUILTINS)
    expect(ConfigProviderPreset.effective({})).toEqual(ConfigProviderPreset.BUILTINS)
  })

  it("merges an override field-wise: a baseURL fix keeps the builtin name/keyURL/channel", () => {
    const merged = ConfigProviderPreset.effective({
      anthropic: ConfigProviderPreset.Info.make({ baseURL: "https://api.anthropic-moved.example/v1" }),
    })
    expect(merged.anthropic.baseURL).toBe("https://api.anthropic-moved.example/v1")
    expect(merged.anthropic.name).toBe("Anthropic")
    expect(merged.anthropic.keyURL).toBe(ConfigProviderPreset.BUILTINS.anthropic.keyURL)
    expect(merged.anthropic.api).toBe("@ai-sdk/anthropic")
    expect(merged.anthropic.authStyle).toBe("anthropic")
    // Other builtins untouched.
    expect(merged.deepseek).toEqual(ConfigProviderPreset.BUILTINS.deepseek)
  })

  it("adds unknown ids as new presets and carries hidden through", () => {
    const merged = ConfigProviderPreset.effective({
      myproxy: ConfigProviderPreset.Info.make({ name: "My proxy", baseURL: "http://10.0.0.5:8000/v1" }),
      openai: ConfigProviderPreset.Info.make({ hidden: true }),
    })
    expect(merged.myproxy.name).toBe("My proxy")
    expect(merged.myproxy.baseURL).toBe("http://10.0.0.5:8000/v1")
    expect(merged.openai.hidden).toBe(true)
    expect(merged.openai.name).toBe("OpenAI")
  })

  it("decodes a sparse config fragment and rejects an out-of-set API channel", () => {
    const decoded = Schema.decodeUnknownSync(ConfigProviderPreset.Info)({ baseURL: "https://x.example/v1" })
    expect(decoded.baseURL).toBe("https://x.example/v1")
    expect(decoded.name).toBeUndefined()
    // The closed adapter set is baked into the schema: a runtime "fix" can never invent a
    // fourth channel (no vendor npm ever loads by name).
    expect(() =>
      Schema.decodeUnknownSync(ConfigProviderPreset.Info)({ api: "@ai-sdk/some-vendor" }),
    ).toThrow()
  })
})
