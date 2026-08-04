import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CatalogModelStatus, ModelsDev } from "@novaclaw/core/models-dev"
import { ModelV2 } from "@novaclaw/core/model"

describe("provider model status schemas", () => {
  test("keeps catalog status separate from the native model status", () => {
    expect(Schema.decodeUnknownSync(CatalogModelStatus)("deprecated")).toBe("deprecated")
    expect(() => Schema.decodeUnknownSync(CatalogModelStatus)("active")).toThrow()
    expect(Schema.decodeUnknownSync(ModelV2.Info.fields.status)("active")).toBe("active")
  })

  test("models.dev entries without a status decode to undefined", () => {
    expect(
      Schema.decodeUnknownSync(ModelsDev.Model)({
        id: "test-model",
        name: "Test Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      }).status,
    ).toBeUndefined()
  })
})
