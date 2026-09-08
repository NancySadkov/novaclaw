import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { dict as en } from "@/i18n/en"

const source = fs.readFileSync(path.join(import.meta.dir, "dialog-model-config.tsx"), "utf8")
const caller = fs.readFileSync(path.join(import.meta.dir, "models.tsx"), "utf8")
/** ⚠️ The preset TABLE now lives here, not in the dialog: it was lifted into a shared module so the
 *  Affective settings tab could sell temperature the same way. The recovery test below scans this
 *  file, because scanning the dialog would silently pass on a file that no longer holds the table. */
const presets = fs.readFileSync(path.join(import.meta.dir, "parts", "preset-value.ts"), "utf8")

describe("Model Configure — identity and connection", () => {
  test("shows the connection name, resolved API path, wire model ID, and friendly name", () => {
    expect(source).toContain('apiPath: providerCfg().api?.url ?? props.providerApi.url ?? ""')
    expect(source).toContain("providerName: customProviderName()")
    expect(source).toContain("modelID: init.api?.id ?? props.apiModelID")
    expect(source).toContain("modelName: init.name ?? props.modelName")
    expect(source).toContain("value={form.apiPath}")
    expect(source).toContain("value={form.providerName}")
    expect(source).toContain("value={form.modelID}")
    expect(source).toContain("value={form.modelName}")
    expect(caller).toContain("apiModelID={item.api.id}")
    expect(caller).toContain("providerApi={item.provider.api}")
  })

  test("saves the wire ID and name without renaming the stable catalog key", () => {
    expect(source).toContain("name: form.modelName.trim() || props.modelName")
    expect(source).toContain("api: { ...(saved.api ?? {}), id: form.modelID.trim() || props.apiModelID }")
    expect(source).toContain("[props.modelID]: model")
    expect(source).not.toContain("[form.modelID]: model")
  })

  test("keeps the complete API channel when changing its URL", () => {
    expect(source).toContain("{ ...(provider.api ?? props.providerApi), url: apiPath }")
    const decoded = Schema.decodeUnknownSync(ConfigProvider.Info)({
      api: {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://llm.example/v1",
        settings: { timeout: 30 },
      },
      models: {
        stable: {
          name: "Friendly model",
          api: { id: "upstream/model-id" },
        },
      },
    })
    expect(decoded.api?.url).toBe("https://llm.example/v1")
    expect(decoded.models?.stable?.name).toBe("Friendly model")
    expect(String(decoded.models?.stable?.api?.id)).toBe("upstream/model-id")
  })

  test("allows a concise connection name later and otherwise falls back to the endpoint", () => {
    expect(source).toContain(
      'name: form.providerName.trim() || (provider.name === "local" ? "local" : apiPath || props.providerID)',
    )
    expect(en["settings.models.config.providerName.name"]).toContain("optional")
    // The fallback rule moved behind the row's explain affordance when the descriptions were
    // shortened (2026-08-24): the row says what the field IS, the `?` says what leaving it blank
    // does. Still asserted — where it is said changed, whether it is said did not.
    expect(en["settings.models.config.providerName.desc.more"]).toContain("serving URL")
  })

  test("has human labels for all identity fields", () => {
    for (const key of ["providerName", "apiPath", "modelID", "modelName"])
      for (const suffix of ["name", "desc"]) expect(`settings.models.config.${key}.${suffix}` in en).toBe(true)
  })
})

describe("Model Configure — recovery", () => {
  test("offers named recovery postures and explains the longest outage window", () => {
    for (const [word, attempts] of [
      ["once", 1],
      ["quickRecovery", 3],
      ["patientRecovery", 5],
      ["persistentRecovery", 10],
    ] as const) {
      expect(presets).toContain(`{ word: "${word}", num: ${attempts} }`)
      expect(`settings.models.config.preset.${word}` in en).toBe(true)
    }
    expect(en["settings.models.config.retryAttempts.desc"]).toContain("about three minutes")
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THINKING EFFORT — the parameter the inference server receives.
//
// 🔴 Owner report 2026-09-03: "ensure the model configure exposes the Thinking Effort (the one sent
// to the model inference server) for the models which support it." Before this it could only be set
// by knowing the literal `reasoning_effort` and typing it into a raw body field — principle 12's c64
// line, and 12(b)'s "every list-shaped setting offers its list" with no list offered.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("Model Configure — thinking effort", () => {
  test("offers the effort list without an inert capability switch", () => {
    expect(source).toContain('const THINKING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]')
    expect(source).toContain('options={["", ...THINKING_EFFORTS]}')
    expect(source).not.toContain("form.reasoning")
    expect(source).toContain('data-action="settings-model-thinking-effort"')
  })

  test("round-trips through request.body.reasoning_effort, and unset CLEARS the key", () => {
    // Read the stored override; absence leaves the server default in force.
    expect(source).toContain("reasoning_effort")
    expect(source).toContain("const value = bodyEffort(init)")
    // …and written where the wire will carry it: `request.body` survives into the HTTP overlay
    // (`session/runner/model.ts` → `withDefaults` → `splitModelSampling`), unlike `thinkingBudget`
    // beside it, which is pulled out before the wire because it is NovaClaw's own controller.
    expect(source).toContain("if (form.thinkingEffort) body.reasoning_effort = form.thinkingEffort")
    expect(source).toContain("else delete body.reasoning_effort")
  })

  test("every effort the list offers has a human label, and unset says whose default it is", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      expect(typeof en[`settings.models.config.thinkingEffort.value.${effort}` as keyof typeof en]).toBe("string")
    expect(en["settings.models.config.thinkingEffort.unset"]).toBe("Server default")
    // The two names are nearly identical and the mechanisms are not, so the copy separates them.
    expect(en["settings.models.config.thinkingEffort.desc.more"]).toContain("reasoning_effort")
    expect(en["settings.models.config.thinkingEffort.desc.more"]).toContain("Thinking budget")
  })
})
