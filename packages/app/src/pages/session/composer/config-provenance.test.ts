import { describe, expect, test } from "bun:test"
import {
  draftOrigins,
  draftProjectLayer,
  draftStances,
  featureOrigins,
  projectLayer,
  switchStance,
  type ResolvedConfigLike,
} from "./config-provenance"

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

/**
 * ─── THE DRAFT HALF ────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 **A draft's switches stated the INSTANCE's stance about a folder that had already decided.**
 * Measured in dev Electron 2026-08-19: a draft in a folder whose `novaclaw.json` declares
 * `quality: true` rendered *"Quality gates … Using Settings default: Off"*, while a session created
 * in that same folder resolves `quality: {value: true, source: {kind:"project", file: …}}`. The
 * sentence directly above those switches had already been fixed to name the folder's file, so one
 * panel made two contradictory claims about one folder — worse than the original silence.
 *
 * The matrix below is the one that failed: *folder declares it on / off / says nothing* against
 * *instance default on / off*. `switchStance` is the same expression the composer renders with, so
 * these cases exercise the shipped precedence rather than a restatement of it.
 */

const FILE = "C:/work/app/novaclaw.json"
/** A `GET /api/project` answer for a folder that declares `quality`. */
const folderDeclaring = (features: Record<string, boolean>, refused: string[] = []) => ({
  kind: "project",
  root: "C:/work/app",
  file: FILE,
  tune: { features, applied: Object.keys(features), refused, deferred: [] },
})

/** What the switch READS, composed exactly as the composer composes it. */
const reads = (found: Parameters<typeof draftStances>[0], instance: boolean, own?: boolean) =>
  switchStance({ own, kernel: draftStances(found).quality, instance })

describe("a draft's switches show the FOLDER's stance, not the instance's", () => {
  test("folder ON × instance OFF — the switch reads ON and names the file", () => {
    const found = folderDeclaring({ quality: true })
    expect(reads(found, false)).toBe(true)
    expect(draftOrigins(found).quality).toEqual({ kind: "project", file: FILE })
  })

  test("folder ON × instance ON — still the folder's, and it still says so", () => {
    // The value agrees either way; the ORIGIN line is the whole difference, and getting it wrong
    // sends someone to Settings to change something Settings does not control.
    const found = folderDeclaring({ quality: true })
    expect(reads(found, true)).toBe(true)
    expect(draftOrigins(found).quality).toEqual({ kind: "project", file: FILE })
  })

  test("folder OFF × instance ON — the switch reads OFF", () => {
    // `quality` is not a supervision switch, so a folder may turn it off and the server applies it.
    const found = folderDeclaring({ quality: false })
    expect(reads(found, true)).toBe(false)
    expect(draftOrigins(found).quality).toEqual({ kind: "project", file: FILE })
  })

  test("folder OFF × instance OFF — off, and attributed to the folder rather than to Settings", () => {
    const found = folderDeclaring({ quality: false })
    expect(reads(found, false)).toBe(false)
    expect(draftOrigins(found).quality).toEqual({ kind: "project", file: FILE })
  })

  test("folder SILENT × instance ON / OFF — the instance answers, and claims no origin", () => {
    const found = folderDeclaring({ memory: true })
    expect(reads(found, true)).toBe(true)
    expect(reads(found, false)).toBe(false)
    // ⚠️ No `{kind:"instance"}` is invented here. The panel already treats an absent origin as the
    // instance; claiming it in a second place is a second thing to keep in step.
    expect(draftOrigins(found).quality).toBeUndefined()
    expect(draftOrigins(found).memory).toEqual({ kind: "project", file: FILE })
  })

  test("this chat's own flip still wins over the folder", () => {
    const found = folderDeclaring({ quality: true })
    expect(reads(found, false, false)).toBe(false)
  })

  test("a REFUSED supervision switch is not reported as applied", () => {
    // A folder may raise a safety rail and never lower one. The server drops the `false` and reports
    // it, so the switch keeps the instance's ON and the panel can say the file asked and did not get.
    const found = folderDeclaring({}, ["safeMode"])
    expect(switchStance({ own: undefined, kernel: draftStances(found).safeMode, instance: true })).toBe(true)
    expect(draftOrigins(found).safeMode).toBeUndefined()
    expect(draftProjectLayer(found)).toEqual({ root: "C:/work/app", file: FILE, applied: [], refused: ["safeMode"] })
  })

  test("the folder's own section is built from the same answer", () => {
    expect(draftProjectLayer(folderDeclaring({ quality: true, memory: false }))).toEqual({
      root: "C:/work/app",
      file: FILE,
      applied: ["quality", "memory"],
      refused: [],
    })
  })

  test("a key this panel does not show never reaches the switch record", () => {
    // `features` is keyed by config-field name and a future build may declare more of them.
    const found = folderDeclaring({ quality: true, somethingNew: true } as Record<string, boolean>)
    expect(Object.keys(draftStances(found))).toEqual(["quality"])
    expect(draftProjectLayer(found)?.applied).toEqual(["quality"])
  })

  test("no folder, a broken file, or a probe still in flight all claim NOTHING", () => {
    for (const found of [
      undefined,
      { kind: "none" },
      { kind: "invalid", file: FILE, reason: "would-not-parse" },
    ] as Parameters<typeof draftStances>[0][]) {
      expect(draftStances(found)).toEqual({})
      expect(draftOrigins(found)).toEqual({})
      expect(draftProjectLayer(found)).toBeUndefined()
    }
  })

  test("an instance that answers without `tune` degrades to silence, never to OFF", () => {
    // The field is newer than the route. Claiming "off" for a folder we were not told about is the
    // original defect with a different cause.
    const older = { kind: "project", root: "C:/work/app", file: FILE }
    expect(draftStances(older)).toEqual({})
    expect(draftOrigins(older)).toEqual({})
    expect(draftProjectLayer(older), "no `applied` means nothing honest to summarise").toBeUndefined()
    expect(switchStance({ own: undefined, kernel: draftStances(older).quality, instance: true })).toBe(true)
  })
})
