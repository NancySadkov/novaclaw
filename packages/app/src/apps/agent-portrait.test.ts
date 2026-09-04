import { describe, expect, test } from "bun:test"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { BESPOKE_AGENT_PORTRAITS, agentPortraitPlaceholder, agentPortraitSource } from "./agent-portrait"

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

  test("bespoke portraits are real PNGs, not WebP files behind a renamed extension", async () => {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    for (const name of BESPOKE_AGENT_PORTRAITS) {
      const resource = agentPortraitSource(name)!
      expect(resource.endsWith(".png"), resource).toBe(true)
      const bytes = new Uint8Array(await Bun.file(new URL(`../../public${resource}`, import.meta.url)).arrayBuffer())
      expect([...bytes.slice(0, 8)], resource).toEqual(signature)
    }
  })

  test("reuses the original portrait for a numbered collision", () => {
    expect(agentPortraitSource("theron-12")).toBe(agentPortraitSource("theron"))
  })

  test("leaves custom agent ids on the existing fallback", () => {
    expect(agentPortraitSource("my-private-researcher")).toBeUndefined()
  })

  test("🔴 a colleague's own avatar hides the shipped portrait; the pool is only the placeholder", () => {
    expect(agentPortraitPlaceholder("theron", undefined)).toBe(agentPortraitSource("theron"))
    expect(agentPortraitPlaceholder("theron", "🦊")).toBeUndefined()
    expect(agentPortraitPlaceholder("daedalus", "")).toBe(agentPortraitSource("daedalus"))
  })
})
