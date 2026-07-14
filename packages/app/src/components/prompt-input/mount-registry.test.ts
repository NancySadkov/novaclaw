import { describe, expect, test } from "bun:test"
import { createComposerMountRegistry } from "./mount-registry"

function harness() {
  const warnings: string[] = []
  const checks: Array<() => void> = []
  const registry = createComposerMountRegistry({
    warn: (message) => warnings.push(message),
    schedule: (check) => checks.push(check),
  })
  const settle = () => {
    while (checks.length) checks.shift()!()
  }
  return { registry, warnings, settle }
}

describe("composer mount registry (ui-arch P3)", () => {
  test("register/release round-trips the count", () => {
    const { registry } = harness()
    const release = registry.register("ses_1")
    expect(registry.count("ses_1")).toBe(1)
    release()
    expect(registry.count("ses_1")).toBe(0)
    expect(registry.snapshot()).toEqual({})
  })

  test("release is idempotent and never underflows a sibling instance", () => {
    const { registry, settle } = harness()
    const first = registry.register("ses_1")
    const second = registry.register("ses_1")
    first()
    first() // double-release must not free the surviving instance's slot
    expect(registry.count("ses_1")).toBe(1)
    settle()
    second()
    expect(registry.count("ses_1")).toBe(0)
  })

  test("a steady-state duplicate for one session warns", () => {
    const { registry, warnings, settle } = harness()
    registry.register("ses_1")
    registry.register("ses_1")
    expect(warnings).toEqual([]) // not before the deferred check
    settle()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("ses_1")
    expect(warnings[0]).toContain("2 PromptInput instances")
  })

  test("a transient router-transition overlap does not warn", () => {
    const { registry, warnings, settle } = harness()
    const outgoing = registry.register("ses_1")
    registry.register("ses_1") // incoming view mounts while the outgoing is being swapped out
    outgoing()
    settle()
    expect(warnings).toEqual([])
    expect(registry.count("ses_1")).toBe(1)
  })

  test("distinct sessions never cross-trip", () => {
    const { registry, warnings, settle } = harness()
    registry.register("ses_1")
    registry.register("ses_2")
    registry.register("draft")
    settle()
    expect(warnings).toEqual([])
    expect(registry.snapshot()).toEqual({ ses_1: 1, ses_2: 1, draft: 1 })
  })
})
