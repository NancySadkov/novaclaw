import { describe, expect, test } from "bun:test"
import { featureOrigins, projectLayer, type ResolvedConfigLike } from "./config-provenance"

/**
 * The panel renders whatever this mapping hands it, so a mistake here is a confident, wrong sentence
 * about where a setting came from — on the one surface a person opens when they are already
 * confused. Every case below is a way to get that wrong.
 */

describe("where a switch's value came from", () => {
  test("🔴 a chain layer OUTRANKS the default source — `origin` is checked first", () => {
    // The wire's contract: `origin` names the chain layer that supplied the value, and `source`
    // answers only when no layer moved it. Reading `source` first would tell a user their PROJECT
    // set something a parent chat chose. A response carrying both is malformed, and this pins which
    // one wins if one ever does.
    const resolved: ResolvedConfigLike = {
      fields: { safeMode: { origin: "ses_parent", source: { kind: "project", file: "C:/w/novaclaw.json" } } },
    }
    expect(featureOrigins(resolved).safeMode).toEqual({ kind: "session" })
  })

  test("a folder-supplied switch names its file", () => {
    const resolved: ResolvedConfigLike = {
      fields: { memory: { source: { kind: "project", file: "C:/work/app/novaclaw.json" } } },
    }
    expect(featureOrigins(resolved).memory).toEqual({ kind: "project", file: "C:/work/app/novaclaw.json" })
  })

  test("a project source with no file is NOT reported as a project", () => {
    // Degrading to "not known" beats rendering "Set by this folder's project file" with nothing to
    // point at — the sentence's whole value is the path.
    const resolved: ResolvedConfigLike = { fields: { memory: { source: { kind: "project" } } } }
    expect(featureOrigins(resolved).memory).toBeUndefined()
  })

  test("the instance default is reported as such, and an absent field yields nothing", () => {
    const resolved: ResolvedConfigLike = { fields: { quality: { source: { kind: "instance" } } } }
    const origins = featureOrigins(resolved)
    expect(origins.quality).toEqual({ kind: "instance" })
    expect(origins.safeMode, "a field the response omits must not invent an origin").toBeUndefined()
  })

  test("no response at all is an empty map, never a throw", () => {
    // The panel is rendered before the request settles on every open. A throw here would take the
    // whole Tuning dialog down to explain where a value came from.
    expect(featureOrigins(undefined)).toEqual({})
    expect(featureOrigins({})).toEqual({})
    expect(projectLayer(undefined)).toBeUndefined()
  })

  test("a field this panel does not show is ignored", () => {
    // `fields` is an open map over EVERY config field — model, agent, permissionMode and the rest.
    // Only the ten switches are on this panel, and mapping the others would put keys in a record the
    // renderer indexes by feature name.
    const resolved: ResolvedConfigLike = { fields: { permissionMode: { source: { kind: "instance" } } } }
    expect(Object.keys(featureOrigins(resolved))).toEqual([])
  })

  test("the project layer carries the file and both of its lists", () => {
    const resolved: ResolvedConfigLike = {
      project: {
        root: "C:/work/app",
        file: "C:/work/app/novaclaw.json",
        applied: ["memory"],
        // Refused is not cosmetic: a folder may RAISE a supervision switch and never lower one, so
        // this is the file asking for something it may not have — worth showing, not swallowing.
        refused: ["askBeforeChanges"],
      },
    }
    expect(projectLayer(resolved)).toEqual({
      root: "C:/work/app",
      file: "C:/work/app/novaclaw.json",
      applied: ["memory"],
      refused: ["askBeforeChanges"],
    })
  })
})
