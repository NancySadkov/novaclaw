import { describe, expect, test } from "bun:test"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { agentPortraitSource } from "./agent-portrait"

describe("builtin agent portraits", () => {
  test("has a lazy client resource for Nova and every pooled officer name", async () => {
    const resources = ["nova", ...OfficerName.POOL].map((name) => agentPortraitSource(name))
    expect(resources.every((resource) => resource !== undefined)).toBe(true)
    expect(new Set(resources).size).toBe(OfficerName.POOL.length + 1)

    for (const resource of resources) {
      const file = new URL(`../../public${resource}`, import.meta.url)
      expect(await Bun.file(file).exists(), resource).toBe(true)
    }
  })

  test("reuses the original portrait for a numbered collision", () => {
    expect(agentPortraitSource("theron-12")).toBe(agentPortraitSource("theron"))
  })

  test("leaves custom agent ids on the existing fallback", () => {
    expect(agentPortraitSource("my-private-researcher")).toBeUndefined()
  })
})
