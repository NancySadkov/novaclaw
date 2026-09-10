import { describe, expect, test } from "bun:test"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { PermissionV2 } from "@novaclaw/core/permission"

/**
 * THE PAIRING INVARIANT. `withOwnScratch` does two things at once — drop a stored scratch grant that
 * names a DIFFERENT officer, and grant this agent its own. Either half alone is a defect wearing the
 * other as an excuse: granting without stripping leaves one officer holding a write grant into a
 * colleague's private workspace; stripping without granting turns that leak into a refusal, which is
 * the failure an operator otherwise has to design around by hand.
 *
 * This is the class measured on a live instance 2026-09-10, where a cloned officer's stored layer
 * carried `…/scratch/daedalus/*` instead of its own: it could write a colleague's notes and could not
 * write its own, and the system prompt it was given promised the opposite in as many words.
 *
 * Driven through the REAL evaluator, not a re-implementation of it — a test that reimplements the
 * matcher only ever proves the test.
 */
const OWNED = "geryon"
const own = AgentPlugin.scratchDirsFor(OWNED).at(-1)!
const foreign = own.replace(`/${OWNED}/*`, "/daedalus/*")
const shared = "C:/Users/x/AppData/Local/Temp/novaclaw/*"
const effect = (rules: PermissionV2.Ruleset, action: string, resource: string) =>
  PermissionV2.evaluate(action, resource, rules).effect
const file = (glob: string) => `${glob.slice(0, -2)}/note.txt`

const staleLayer: PermissionV2.Ruleset = [
  { action: "external_directory_write", resource: "*", effect: "ask" },
  { action: "external_directory_read", resource: foreign, effect: "allow" },
  { action: "external_directory_write", resource: foreign, effect: "allow" },
  { action: "external_directory_read", resource: shared, effect: "allow" },
  { action: "external_directory_write", resource: shared, effect: "allow" },
]

describe("the scratch grant is derived, and always paired", () => {
  test("the STALE layer really does both wrong — or the fix below proves nothing", () => {
    expect(effect(staleLayer, "external_directory_write", file(own))).toBe("ask")
    expect(effect(staleLayer, "external_directory_write", file(foreign))).toBe("allow")
  })

  test("after: own is writable, the colleague's is not", () => {
    const fixed = AgentPlugin.withOwnScratch(OWNED, staleLayer)
    expect(effect(fixed, "external_directory_write", file(own))).toBe("allow")
    expect(effect(fixed, "external_directory_read", file(own))).toBe("allow")
    expect(effect(fixed, "external_directory_write", file(foreign))).not.toBe("allow")
  })

  test("PAIRING: no scratch grant survives that is not the agent's own, and own is always granted", () => {
    for (const layer of [
      staleLayer,
      [],
      [{ action: "external_directory_write", resource: foreign, effect: "deny" }] as PermissionV2.Ruleset,
      staleLayer.filter((rule) => !rule.resource.includes("/scratch/")),
      AgentPlugin.withOwnScratch(OWNED, staleLayer),
    ]) {
      const fixed = AgentPlugin.withOwnScratch(OWNED, layer)
      const scratchGrants = fixed
        .filter((rule) => rule.resource.includes("/scratch/"))
        .map((rule) => rule.resource)
      expect(scratchGrants.every((resource) => resource === own)).toBe(true)
      expect(effect(fixed, "external_directory_write", file(own))).toBe("allow")
    }
  })

  test("it is IDEMPOTENT — a second pass changes nothing", () => {
    const once = AgentPlugin.withOwnScratch(OWNED, staleLayer)
    expect(AgentPlugin.withOwnScratch(OWNED, once)).toEqual(once)
  })

  test("it narrows nothing else: the shared temp root keeps its grant", () => {
    const fixed = AgentPlugin.withOwnScratch(OWNED, staleLayer)
    expect(effect(fixed, "external_directory_write", file(shared))).toBe("allow")
  })

  test("NEGATIVE CONTROL: the two scratch globs are actually different paths", () => {
    // Without this, a bug making `foreign` equal `own` would satisfy every assertion above.
    expect(foreign).not.toBe(own)
    expect(foreign.includes(OWNED)).toBe(false)
  })
})
