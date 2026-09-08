import { describe, expect, test } from "bun:test"
import type { ProjectFile } from "@novaclaw/schema/project-file"
import { ProjectDefaults } from "@novaclaw/core/session/project-defaults"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  resolveConfig,
  SESSION_CONFIG_FIELDS,
  type EffectiveConfig,
  type SessionConfig,
} from "@novaclaw/core/session/config-resolve"

/**
 * A folder's `novaclaw.json` is a layer BENEATH the session entity, never a component written onto
 * it. These tests pin the precedence that claim rests on, and the two structural properties that
 * would be lost if the values were stamped onto the row instead.
 */

const tune = (features: Record<string, boolean>) => ({ features }) as never

describe("a folder's tune as a defaults layer", () => {
  test("supplies a component no session row declares", () => {
    const { defaults } = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ surgicalEdits: true }))
    expect(resolveConfig(defaults, []).surgicalEdits).toBe(true)
  })

  test("🔴 the session's own row outranks it — the whole point of the ordering", () => {
    const { defaults } = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ surgicalEdits: true }))
    const own: SessionConfig = { surgicalEdits: false }
    expect(resolveConfig(defaults, [own]).surgicalEdits).toBe(false)
  })

  test("🔴 a parent's stance outranks it too", () => {
    const { defaults } = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ askBeforeChanges: false }))
    const parent: SessionConfig = { askBeforeChanges: true }
    const child: SessionConfig = {}
    // A repository saying "do not ask" cannot shed a parent session's ask-before-changes: the chain is
    // above this layer, so the narrowing is structural rather than a check that has to fire.
    expect(resolveConfig(defaults, [parent, child]).askBeforeChanges).toBe(true)
  })

  test("an absent tune changes nothing at all", () => {
    const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, undefined)
    expect(folded.defaults).toBe(EFFECTIVE_CONFIG_DEFAULTS)
    expect(folded.refused).toEqual([])
  })

  test("🔴 it does not become a row — the entity keeps only what diverged", () => {
    // The ECS discipline architecture.md states: "only divergent values create rows". The fold
    // produces DEFAULTS; nothing here may end up looking like a session's own declaration, because
    // a fork copies declared columns and the composer renders "you chose this" for them.
    const { defaults } = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ surgicalEdits: true }))
    const chain: SessionConfig[] = [{}]
    const resolved = resolveConfig(defaults, chain)
    expect(resolved.surgicalEdits).toBe(true)
    // The layer that represents the session declared nothing, and still declares nothing.
    expect(chain[0]).toEqual({})
  })

  test("refuses a supervision switch that would lower a default below this layer, and says which", () => {
    // Today `EFFECTIVE_CONFIG_DEFAULTS` carries no supervision entry, so this is reachable only by
    // constructing the base an instance-wide default WOULD produce. That is the case `narrowTune`
    // exists to hold: when such a default lands, a repository must not be able to undo it.
    const base: EffectiveConfig = { ...EFFECTIVE_CONFIG_DEFAULTS, safeMode: true }
    const folded = ProjectDefaults.fold(base, tune({ safeMode: false }))
    expect(folded.defaults.safeMode).toBe(true)
    expect(folded.refused).toEqual(["safeMode"])
  })

  test("a preference switch may still be lowered by the folder", () => {
    const base: EffectiveConfig = { ...EFFECTIVE_CONFIG_DEFAULTS, surgicalEdits: true }
    const folded = ProjectDefaults.fold(base, tune({ surgicalEdits: false }))
    expect(folded.defaults.surgicalEdits).toBe(false)
    expect(folded.refused).toEqual([])
  })

  test("🔴 the narrow-merge field keeps ROOT authority — the layer is not chain index 0", () => {
    // `resolveConfig` lets chain index 0 set a `merge: "narrow"` field freely and clamps deeper
    // layers. If the folder had been prepended to the chain instead of folded into the defaults,
    // the session root would land at index 1 and its own permission mode would be clamped.
    expect(SESSION_CONFIG_FIELDS.permissionMode.merge).toBe("narrow")
    const { defaults } = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ surgicalEdits: true }))
    const root: SessionConfig = { permissionMode: "yolo" }
    expect(resolveConfig(defaults, [root]).permissionMode).toBe("yolo")
  })

  test("every switch the file may carry is a real component of the session", () => {
    // A ratchet across the two lists: a tune field that is not a `SessionConfig` component would
    // fold into defaults and then be dropped by `resolveConfig`, which reads only declared keys —
    // a setting that silently does nothing.
    const declared = [
      "safeMode",
      "askBeforeChanges",
      "surgicalEdits",
      "contextBudget",
      "memory",
      "introspection",
      "quality",
      "affective",
    ] as const
    for (const feature of declared) {
      expect(SESSION_CONFIG_FIELDS[feature], `${feature} is not a session component`).toBeDefined()
    }
    // Survival through resolution is asserted only for the WIRED ones — the rest are deferred by
    // design until their readers fold, and asserting otherwise would pin the bug this prevents.
    const { defaults } = ProjectDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      tune(Object.fromEntries(declared.map((name) => [name, true]))),
    )
    const resolved = resolveConfig(defaults, [])
    for (const feature of ProjectDefaults.WIRED) {
      expect(resolved[feature], `${feature} is wired but did not survive resolution`).toBe(true)
    }
  })
})

describe("the wired set", () => {
  test("a component with an unwired reader is DEFERRED, not applied", () => {
    // ⚠️ Synthetic, because every declared switch IS wired now (2026-08-13) — the whole set moved
    // once `SessionEffectiveConfig` became the single place the fold happens. Pinning the mechanism
    // against a real unwired feature was only possible while one existed; asserting it against a
    // name outside `WIRED` keeps the DEFERRED arm covered for the next switch someone adds. A
    // reader that resolves the chain itself is still the hazard this arm exists for
    // (`project-defaults-entry-point.test.ts` is what notices one appearing).
    const unwired = "notAFeature" as ProjectFile.TuneFeature
    const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ [unwired]: true }))
    expect(folded.deferred).toEqual([unwired])
    expect(folded.applied).toEqual([])
    expect(folded.defaults).toEqual(EFFECTIVE_CONFIG_DEFAULTS)
  })

  test("safeMode reaches BOTH its readers now, so it applies", () => {
    // The case the arm above used to pin. `tool/bash.ts` and the strict drain both resolve through
    // the entry point, which is what makes applying it honest rather than half on.
    const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ safeMode: true }))
    expect(resolveConfig(folded.defaults, []).safeMode).toBe(true)
    expect(folded.applied).toEqual(["safeMode"])
    expect(folded.deferred).toEqual([])
  })

  test("a wired component applies and is reported as applied", () => {
    const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, tune({ surgicalEdits: true }))
    expect(resolveConfig(folded.defaults, []).surgicalEdits).toBe(true)
    expect(folded.applied).toEqual(["surgicalEdits"])
    expect(folded.deferred).toEqual([])
  })

  test("🔴 every wired component is a real session component", () => {
    // A name in the wired set that is not a config field would fold into defaults and be dropped by
    // `resolveConfig`, which reads only descriptor keys — a switch that silently does nothing.
    for (const feature of ProjectDefaults.WIRED) {
      expect(SESSION_CONFIG_FIELDS[feature], `${feature} is wired but is not a component`).toBeDefined()
    }
  })

  test("a refused switch is never also reported as applied or deferred", () => {
    const base: EffectiveConfig = { ...EFFECTIVE_CONFIG_DEFAULTS, askBeforeChanges: true }
    const folded = ProjectDefaults.fold(base, tune({ askBeforeChanges: false }))
    expect(folded.refused).toEqual(["askBeforeChanges"])
    expect(folded.applied).toEqual([])
    expect(folded.deferred).toEqual([])
    expect(folded.defaults.askBeforeChanges).toBe(true)
  })
})
