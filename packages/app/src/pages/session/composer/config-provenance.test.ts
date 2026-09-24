import { describe, expect, test } from "bun:test"
import { featureOrigins, switchStance, type ResolvedConfigLike } from "./config-provenance"

/**
 * The panel renders whatever this mapping hands it, so a mistake here is a confident, wrong sentence
 * about where a setting came from — on the one surface a person opens when they are already
 * confused. Every case below is a way to get that wrong.
 */

describe("where a switch's value came from", () => {
  test("🔴 a chain layer OUTRANKS the default source — `origin` is checked first", () => {
    // The wire's contract: `origin` names the chain layer that supplied the value, and `source`
    // answers only when no layer moved it. Reading `source` first would tell a user another layer
    // set something a parent chat chose. A response carrying both is malformed, and this pins which
    // one wins if one ever does. (The fixture sent `kind: "project"` until 2026-09-17; that source
    // cannot appear on the wire any more, and the property is about the shape, not the sender.)
    const resolved: ResolvedConfigLike = {
      fields: { safeMode: { origin: "ses_parent", source: { kind: "agent" } } },
    }
    expect(featureOrigins(resolved).safeMode).toEqual({ kind: "session" })
  })

  test("the instance default is reported as such, and an absent field yields nothing", () => {
    const resolved: ResolvedConfigLike = { fields: { quality: { source: { kind: "instance" } } } }
    const origins = featureOrigins(resolved)
    expect(origins.quality).toEqual({ kind: "instance" })
    expect(origins.safeMode, "a field the response omits must not invent an origin").toBeUndefined()
  })

  test("an officer's default is attributed to the officer", () => {
    const resolved: ResolvedConfigLike = { fields: { quality: { source: { kind: "agent" } } } }
    expect(featureOrigins(resolved).quality).toEqual({ kind: "officer" })
  })

  test("this chat's choice outranks the kernel answer, then the officer baseline", () => {
    expect(switchStance({ own: false, kernel: true, baseline: true })).toBe(false)
    expect(switchStance({ own: undefined, kernel: true, baseline: false })).toBe(true)
    expect(switchStance({ own: undefined, kernel: undefined, baseline: true })).toBe(true)
  })

  test("no response at all is an empty map, never a throw", () => {
    // The panel is rendered before the request settles on every open. A throw here would take the
    // whole Tuning dialog down to explain where a value came from.
    expect(featureOrigins(undefined)).toEqual({})
    expect(featureOrigins({})).toEqual({})
  })

  test("a field this panel does not show is ignored", () => {
    // `fields` is an open map over EVERY config field — model, agent, permissionMode and the rest.
    // Only the ten switches are on this panel, and mapping the others would put keys in a record the
    // renderer indexes by feature name.
    const resolved: ResolvedConfigLike = { fields: { permissionMode: { source: { kind: "instance" } } } }
    expect(Object.keys(featureOrigins(resolved))).toEqual([])
  })
})
