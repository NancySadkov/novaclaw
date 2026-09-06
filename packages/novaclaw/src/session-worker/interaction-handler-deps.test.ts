import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * 🔴 **What may be resolved inside the per-request interaction handler — and why a compiler cannot
 * tell you.**
 *
 * `execution.ts`'s `onInteractionRequest` runs `runLocated(Effect.gen(…))` PER REQUEST. Anything
 * `yield*`-ed in there is asked of the location graph at that moment. Resolving a service the graph
 * **already builds** costs nothing. Resolving a service it does not forces that layer to be
 * constructed inside the per-request scope — and on 2026-08-06 that **abandoned every tool-call turn
 * in the instance**: the tool part was recorded, the drain stopped, and the assistant message never
 * settled. `finish` and `time.completed` stayed null forever.
 *
 * It cost a revert (`f2d944ac6`) and five live bisect splits to find, because:
 *  · it type-checks — the service exists and the effect is well formed;
 *  · every unit test passes — 20/20 units and 16/16 typechecks, plus ten new tests for the feature;
 *  · the failure is a SILENTLY abandoned turn, not an error anywhere.
 *
 * ⚠️ **The four capabilities that were already there are safe BY ACCIDENT** — `AgentV2`,
 * `PermissionV2` and `SessionSpawner` all happen to be services the location graph
 * constructs anyway.
 * Nothing made that true and nothing kept it true, which is exactly the shape ruling 1 exists for.
 *
 * **The rule:** a capability added to the interaction bridge is either built from a value the handler
 * ALREADY HOLDS (the `SessionJoin.fromParts(...)` shape), or resolved from a service on the
 * allow-list below. Adding a name to that list is a claim that the location graph builds it for every
 * session regardless of this handler — check it, do not assume it.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")
const SOURCE = path.join(ROOT, "packages/novaclaw/src/session-worker/execution.ts")
const LOCATION_SERVICES_SOURCE = path.join(ROOT, "packages/core/src/location-services.ts")

/**
 * Services the LOCATION GRAPH already constructs for every session, so resolving them inside the
 * per-request handler builds nothing new.
 *
 * ⚠️ Each entry is a measured claim, not a preference. `SessionJoin` is deliberately ABSENT: it was
 * added here in spirit on 2026-08-06 and had to be reverted.
 */
const ALREADY_IN_THE_GRAPH = new Set([
  "AgentV2", // the authoritative colleague roster, explicitly listed in `locationServices`
  "PermissionV2", // the permission service every turn asserts through
  "SessionSpawner", // the spawn tool's own seam, built for the session that owns the tool
])

/** The `X` of every `yield* X.Service` inside the `onInteractionRequest` handler. */
export const resolvedServices = (source: string): ReadonlyArray<string> => {
  const start = source.indexOf("onInteractionRequest:")
  if (start === -1) return []
  // The handler ends where the next sibling callback begins; `onExecutionRequest` follows it today.
  const after = source.indexOf("onExecutionRequest:", start)
  const body = source.slice(start, after === -1 ? source.length : after)
  // ⚠️ Strip comments FIRST. The handler's own warning comment contains the literal
  // `yield* SessionJoin.Service` as the thing NOT to do, and the first version of this matched it —
  // the guard reporting the very regression it exists to prevent. Same trap as a `cause` inside a doc
  // comment fooling the log-event scanner earlier the same day: a regex over source counts prose too.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  return [...code.matchAll(/yield\*\s+([A-Za-z0-9_]+)\.Service\b/g)].map((match) => match[1]!)
}

describe("the interaction handler resolves only services the location graph already builds", () => {
  const source = fs.readFileSync(SOURCE, "utf8")
  const locationServicesSource = fs.readFileSync(LOCATION_SERVICES_SOURCE, "utf8")

  test("the sweep found the handler at all", () => {
    // Without this the assertion below is vacuously green if the callback is ever renamed or moved.
    expect(source).toContain("onInteractionRequest:")
    expect(resolvedServices(source).length).toBeGreaterThan(0)
  })

  test("🔴 every service resolved there is on the allow-list", () => {
    expect(
      resolvedServices(source)
        .filter((name) => !ALREADY_IN_THE_GRAPH.has(name))
        .map(
          (name) =>
            `${name}.Service is resolved inside onInteractionRequest. If the location graph does not ` +
            `already build it, this abandons every tool-call turn in the instance (silently — it ` +
            `type-checks and every unit test passes). Build it from a value the handler already holds, ` +
            `the way SessionJoin.fromParts(...) does, or add it to ALREADY_IN_THE_GRAPH with the ` +
            `evidence that the graph constructs it for every session.`,
        ),
    ).toEqual([])
  })

  test("🔴 every allow-listed service is explicitly in the location graph", () => {
    const start = locationServicesSource.indexOf("export const locationServices = LayerNode.group([")
    const end = locationServicesSource.indexOf("\n])", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const graph = locationServicesSource.slice(start, end)
    const graphServices = new Set([...graph.matchAll(/\b([A-Za-z0-9_]+)\.node\b/g)].map((match) => match[1]!))
    expect([...ALREADY_IN_THE_GRAPH].filter((name) => !graphServices.has(name))).toEqual([])
  })

  test("⚠️ SessionJoin specifically must NOT come back as a resolution", () => {
    // The exact regression: it is assembled from already-held parts and must stay that way.
    expect(resolvedServices(source)).not.toContain("SessionJoin")
    expect(source).toContain("SessionJoin.fromParts({")
  })

  test("the extractor bites (negative control)", () => {
    // `toEqual([])` over a clean file proves the file is clean, never that the guard can report.
    const synthetic = [
      "onInteractionRequest: (message) =>",
      "  runLocated(Effect.gen(function* () {",
      "    return yield* Bridge.handle({",
      "      permission: yield* PermissionV2.Service,",
      "      rogue: yield* SomethingNew.Service,",
      "    })",
      "  })),",
      "onExecutionRequest: (message) =>",
      "  yield* NotInTheHandler.Service,",
    ].join("\n")
    const found = resolvedServices(synthetic)
    expect(found).toContain("SomethingNew")
    // …and it must not reach past the handler into its siblings.
    expect(found).not.toContain("NotInTheHandler")
  })

  test("🔴 a MENTION in a comment is not a resolution (the bug this extractor shipped with)", () => {
    // The first version matched `yield* SessionJoin.Service` inside the handler's own warning
    // comment and failed, accusing the code of the exact thing that comment forbids.
    const commented = [
      "onInteractionRequest: (message) =>",
      "  // ⚠️ NOT `yield* Ghost.Service` — build it from what the handler holds",
      "  runLocated(Effect.gen(function* () {",
      "    /* also not yield* BlockGhost.Service */",
      "    return yield* Bridge.handle({ permission: yield* PermissionV2.Service })",
      "  })),",
      "onExecutionRequest: (message) =>",
    ].join("\n")
    expect(resolvedServices(commented)).toEqual(["PermissionV2"])
  })
})
