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
    // answers only when no layer moved it. Reading `source` first would tell a user their PROJECT
    // set something a parent chat chose. A response carrying both is malformed, and this pins which
    // one wins if one ever does.
    const resolved: ResolvedConfigLike = {
      fields: { safeMode: { origin: "ses_parent", source: { kind: "project", file: "C:/w/novaclaw.json" } } },
    }
    expect(featureOrigins(resolved).safeMode).toEqual({ kind: "session" })
  })

  // 🗑️ Two cases stood here: "a folder-supplied switch names its file" (a `source.kind === "project"`
  // became `{kind: "project", file}`, so the panel could name the file the user had to edit) and "a
  // project source with no file is NOT reported as a project" (degrading to "not known" beats
  // rendering "Set by this folder's project file" with nothing to point at). Both covered the arm of
  // `featureOrigins` that read the folder layer, which is retired with the `novaclaw.json` mechanism
  // (owner, 2026-09-16). The surviving arms — chain `origin` first, then the instance default — are the
  // cases around them; a `project` source can no longer appear on the wire at all.

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
  })

  test("a field this panel does not show is ignored", () => {
    // `fields` is an open map over EVERY config field — model, agent, permissionMode and the rest.
    // Only the ten switches are on this panel, and mapping the others would put keys in a record the
    // renderer indexes by feature name.
    const resolved: ResolvedConfigLike = { fields: { permissionMode: { source: { kind: "instance" } } } }
    expect(Object.keys(featureOrigins(resolved))).toEqual([])
  })
})

/**
 * 🗑️ THE DRAFT HALF of this file stood here: the cases proving that a draft chat's switches read the
 * FOLDER's stance rather than the instance's, measured 2026-08-19 when a draft in a folder declaring
 * `quality: true` rendered "Using Settings default: Off" while the chat the same click would create
 * resolved `true`. The functions they covered — `draftStances`, `draftOrigins`, `draftProjectLayer`,
 * `governing` and `DiscoveredProjectLike` — read `GET /api/project` and are retired with the
 * `novaclaw.json` mechanism (owner, 2026-09-16). A draft has nothing beneath it now, so there is no
 * folder stance to disagree with the instance's and nothing left to pin here.
 *
 * What remains above is the half whose subject survives: where a SESSION's switch value came from, off
 * the resolved config and the `switchStance` order.
 */
