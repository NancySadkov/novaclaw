import { describe, expect, test } from "bun:test"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"

/**
 * **What a folder alone decides, for a chat that does not exist yet.**
 *
 * A DRAFT has no session id, so `SessionEffectiveConfig.resolution` cannot answer for it, and the
 * composer's Tune panel therefore showed every switch at the INSTANCE stance. Measured in dev
 * Electron 2026-08-19: a draft in a folder declaring `quality: true` rendered *"Quality gates …
 * Using Settings default: Off"* while a session created in that same folder resolves
 * `quality: true` with `source: {kind:"project"}`. The sentence above the switches had already been
 * fixed to name the folder's file, so one panel stated two contradictory things about one folder.
 *
 * 🔴 **The fold belongs here and not in the browser.** `narrowTune` is a security rule and
 * `ProjectDefaults.WIRED` is a capability gate; a renderer re-deriving either is a second
 * implementation of a rule that must have one — and `config-provenance.ts` records the run where a
 * browser-side re-derivation produced toggles that were the exact inverse of the runner's. So
 * `GET /api/project` carries this answer and the client renders it.
 */

const UP = { memory: true } as const

describe("folderStance — the draft's half of the resolution", () => {
  test("a folder that declares nothing supplies nothing", () => {
    const stance = SessionEffectiveConfig.folderStance(undefined, UP)
    expect(stance.applied).toEqual([])
    expect(stance.refused).toEqual([])
    expect(stance.deferred).toEqual([])
    // Not "everything off" — the shipped defaults, untouched. An empty `applied` is the whole point:
    // the panel must fall back to the instance rather than claim the folder said `false`.
    expect(stance.config.quality).toBeUndefined()
  })

  test("a declared switch is applied and NAMED", () => {
    const stance = SessionEffectiveConfig.folderStance({ features: { quality: true } }, UP)
    expect(stance.applied).toEqual(["quality"])
    expect(stance.config.quality).toBe(true)
  })

  test("a folder may turn a non-supervision switch OFF, and that is not the same as silence", () => {
    const off = SessionEffectiveConfig.folderStance({ features: { quality: false } }, UP)
    expect(off.applied).toEqual(["quality"])
    expect(off.config.quality).toBe(false)
    // The distinction the composer renders: `applied` says "this folder decided", and it is what
    // separates a folder's OFF from an instance default that happens to be off.
    expect(SessionEffectiveConfig.folderStance({ features: {} }, UP).applied).toEqual([])
  })

  test("🔴 the MEMORY ceiling takes it back, and the folder is not credited for it", () => {
    // The user's Memory switch is a privacy choice; a folder they cloned five minutes ago must not
    // turn recording back on. Reporting `memory` as applied here would put the folder's name on a
    // value the chat this creates will not have — the false-attribution failure in reverse.
    const withCeiling = SessionEffectiveConfig.folderStance({ features: { memory: true } }, { memory: false })
    expect(withCeiling.config.memory).toBe(false)
    expect(withCeiling.applied).toEqual([])

    const withoutCeiling = SessionEffectiveConfig.folderStance({ features: { memory: true } }, UP)
    expect(withoutCeiling.config.memory).toBe(true)
    expect(withoutCeiling.applied).toEqual(["memory"])
  })

  test("a folder asking memory OFF under an off ceiling agrees with it, so it still counts as applied", () => {
    // The negative control for the case above: the ceiling changed nothing, so the folder really is
    // the layer that decided, and dropping it would under-report just as badly as over-reporting.
    const stance = SessionEffectiveConfig.folderStance({ features: { memory: false } }, { memory: false })
    expect(stance.config.memory).toBe(false)
    expect(stance.applied).toEqual(["memory"])
  })

  test("this is the SAME fold a session gets — same keys, same values", () => {
    // The property that matters is agreement: the draft panel and the session panel must not be able
    // to describe one folder differently. `resolution` folds the identical tune over the identical
    // defaults and then walks a chain, and for a chain of length zero the walk is the identity.
    const tune = { features: { quality: true, introspection: false } }
    const stance = SessionEffectiveConfig.folderStance(tune, UP)
    expect([...stance.applied].sort()).toEqual(["introspection", "quality"])
    expect(stance.config.quality).toBe(true)
    expect(stance.config.introspection).toBe(false)
  })

  test("a supervision switch: refusal needs a TRUE beneath it, and today nothing puts one there", () => {
    // ⚠️ Honest about a currently-unreachable arm rather than asserting a refusal that cannot happen.
    // `narrowTune` refuses a supervision `false` only when the baseline BENEATH the folder is `true`,
    // and `EFFECTIVE_CONFIG_DEFAULTS` carries no supervision default at all — the structure is the
    // security property (`project-defaults.ts`), with `narrowTune` as the backstop for the day an
    // instance-wide default lands. So this route reports the same thing a session's resolution does.
    const stance = SessionEffectiveConfig.folderStance({ features: { safeMode: false } }, UP)
    expect(stance.refused).toEqual([])
    expect(stance.applied).toEqual(["safeMode"])
    expect(stance.config.safeMode).toBe(false)
  })
})
