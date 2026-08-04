import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { dict as en } from "@/i18n/en"

const source = fs.readFileSync(path.join(import.meta.dir, "dialog-model-config.tsx"), "utf8")
const caller = fs.readFileSync(path.join(import.meta.dir, "models.tsx"), "utf8")

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
    expect(en["settings.models.config.providerName.desc"]).toContain("serving URL")
  })

  test("has human labels for all identity fields", () => {
    for (const key of ["providerName", "apiPath", "modelID", "modelName"])
      for (const suffix of ["name", "desc"]) expect(`settings.models.config.${key}.${suffix}` in en).toBe(true)
  })
})
