import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Node } from "@novaclaw/core/effect/app-node"
import { Database } from "@novaclaw/core/database/database"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { EventV2 } from "@novaclaw/core/event"
import { Global } from "@novaclaw/core/global"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { buildLocationServiceMap, locationServices } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { tmpdir } from "./fixture/tmpdir"

// WHY THIS FILE EXISTS (2026-07-28).
//
// `Database`, `Global`, `CredentialCipher`, `MemoryClient` and `SessionScheduler` must exist EXACTLY
// ONCE per process.
// A second `Database` means two SQLite connections to a store whose transaction safety rests on a
// single-connection semaphore (`packages/effect-drizzle-sqlite`); a second `SessionScheduler` means
// two EEVDF ledgers computing fair-share against different totals. Nothing in the tree asserted it.
//
// The property is NOT structural — it is produced by three separate behaviours in
// `location-services.ts` + `effect@4.0.0-beta.83`, any one of which a refactor could remove:
//   1. the underlying global leaves resolve to shared module-level layer objects (CredentialCipher
//      additionally depends on Global), so the per-`compile()` cache and memo map see one identity;
//   2. `LayerMap.make` captures ONE memo map (`Layer.CurrentMemoMap.getOrCreate`) and builds every
//      key with `Layer.buildWithMemoMap(…, memoMap, …)`, so all locations share it;
//   3. `Layer.fresh` — which is `self.build(makeMemoMapUnsafe(), scope)`, i.e. a brand-new ROOT memo
//      map — is applied to the per-location half INSIDE the `Layer.provide` of the global half, so
//      the globals are built outside it.
//
// Break (2) or (3) and every location gets its own `Database`, silently. So this file counts BUILDS
// and collects INSTANCE IDENTITIES across several locations rather than reasoning about layer shape
// (AGENTS.md → Known pitfalls, item −1: "do not reason about instance identity from wrapper shape —
// count builds"). The negative control below reproduces the violating shape and shows both numbers
// go to N.

const LOCATIONS = 3

type Probe = { readonly name: string; builds: number; readonly instances: unknown[] }

const probe = (name: string): Probe => ({ name, builds: 0, instances: [] })

// Wraps a global node's REAL layer, so the graph keeps working while we observe how many times it is
// built and which service object each build produced. Delegating (rather than stubbing) is deliberate:
// a stub would answer a different question — whether the REPLACEMENT is shared — and hoisted globals
// reach the real `Database.node` through their own dependency arrays regardless.
//
// ⚠️ The instrument must not perturb what it measures, and the obvious shape does. A wrapper that
// calls `Layer.build(layer)` inside `Layer.effectContext` reads `Layer.CurrentMemoMap.getOrCreate` off
// the FIBER, not off the memo map the wrapper is being built with — so under the negative control it
// reported 3 builds but 1 instance, i.e. it silently repaired the very sharing it was meant to detect.
// `Layer.tap` threads the caller's memo map into `layer.build`, so the instance identities are the
// graph's own. The counter is a separate memoized leaf (`effectDiscard` is `fromBuildMemo`), which is
// what makes the count "times this node was constructed under the active memo map".
const observe = <A, E>(key: Context.Key<A, any>, layer: Layer.Layer<A, E, never>, record: Probe) =>
  Layer.merge(
    Layer.effectDiscard(
      Effect.sync(() => {
        record.builds++
      }),
    ),
    layer.pipe(
      Layer.tap((context) =>
        Effect.sync(() => {
          record.instances.push(Context.get(context as Context.Context<A>, key))
        }),
      ),
    ),
  ) as Layer.Layer<A, E, never>

const observedGlobals = () => {
  const probes = {
    database: probe(Database.Service.key),
    global: probe(Global.Service.key),
    cipher: probe(CredentialCipher.Service.key),
    memory: probe(MemoryClient.Service.key),
    scheduler: probe(SessionScheduler.Service.key),
  }
  const replacements = [
    [Database.node, observe(Database.Service, Database.node.implementation as never, probes.database)],
    [Global.node, observe(Global.Service, Global.node.implementation as never, probes.global)],
    [
      CredentialCipher.node,
      Node.makeGlobalNode({
        service: CredentialCipher.Service,
        layer: observe(CredentialCipher.Service, CredentialCipher.node.implementation as never, probes.cipher),
        deps: [Global.node],
      }),
    ],
    [Memory.node, observe(MemoryClient.Service, Memory.node.implementation as never, probes.memory)],
    [
      SessionScheduler.node,
      observe(SessionScheduler.Service, SessionScheduler.node.implementation as never, probes.scheduler),
    ],
  ] as unknown as LayerNode.Replacements
  return { probes, replacements }
}

// A faithful mirror of `buildLocationServiceMap`'s key function, parameterised by the ONE thing the
// negative control changes. `freshGlobals: false` must measure identically to production — that is
// what makes the `true` arm evidence about production and not about this copy.
const mirrorLocationServiceMap = (
  replacements: LayerNode.Replacements,
  options: { readonly freshGlobals: boolean },
): Layer.Layer<LocationServiceMap.Service> =>
  Layer.effect(
    LocationServiceMap.Service,
    Effect.map(
      LayerMap.make((ref: Location.Ref) => {
        const all = replacements.concat([[Location.node, Location.boundNode(ref)]])
        const location = LayerNode.hoist(locationServices, Node.tags.values.global, all)
        const globals = LayerNode.compile(location.hoisted)
        return LayerNode.compile(location.node).pipe(
          Layer.fresh,
          Layer.provide(options.freshGlobals ? Layer.fresh(globals) : globals),
        )
      }),
      (map) => ({ ...map }),
    ),
  ) as Layer.Layer<LocationServiceMap.Service>

const measure = async (
  mapLayer?: (replacements: LayerNode.Replacements) => Layer.Layer<LocationServiceMap.Service>,
) => {
  const { probes, replacements } = observedGlobals()
  const all = mapLayer
    ? replacements.concat([
        [
          LocationServiceMap.node,
          Node.makeGlobalNode({ service: LocationServiceMap.Service, layer: mapLayer(replacements), deps: [] }),
        ],
      ] as unknown as LayerNode.Replacements)
    : replacements
  const app = AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SettingsConfigStore.node, LocationServiceMap.node]),
    all,
  ) as Layer.Layer<never, unknown, never>

  const dirs = await Promise.all(Array.from({ length: LOCATIONS }, () => tmpdir()))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const map = yield* LocationServiceMap.Service
        for (const dir of dirs) {
          yield* map.contextEffect(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))
        }
      }).pipe(Effect.scoped, Effect.provide(app)) as Effect.Effect<void, unknown, never>,
    )
  } finally {
    await Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))
  }
  return Object.values(probes)
}

const violations = (probes: readonly Probe[]) =>
  probes.flatMap((item) => {
    const instances = new Set(item.instances).size
    return item.builds === 1 && instances === 1
      ? []
      : [
          `${item.name}: expected exactly 1 build and 1 instance per process, got ${item.builds} builds ` +
            `and ${instances} distinct instances across ${LOCATIONS} locations`,
        ]
  })

describe("location services global identity", () => {
  test("hoists all four direct one-per-process services into the global half", () => {
    const { hoisted } = LayerNode.hoist(locationServices, Node.tags.values.global, [])
    const names = hoisted.dependencies.map((item) => item.name)
    for (const key of [
      Database.Service.key,
      Global.Service.key,
      MemoryClient.Service.key,
      SessionScheduler.Service.key,
    ]) {
      // A node that stops being `global`-tagged would be rebuilt per location by construction, and
      // the build count below would catch it — this assertion just says WHICH invariant broke.
      expect(names).toContain(key)
    }
  })

  test("builds database, global, cipher, memory and scheduler exactly once across three locations", async () => {
    expect(violations(await measure())).toEqual([])
  }, 20000)

  test("measures the same when the production wiring is mirrored locally", async () => {
    expect(
      violations(await measure((replacements) => mirrorLocationServiceMap(replacements, { freshGlobals: false }))),
    ).toEqual([])
  }, 20000)

  // NEGATIVE CONTROL. `Layer.fresh` is exactly the violating shape the pitfall names — a build with a
  // brand-new root memo map, i.e. what a genuinely different layer object or an unshared memo map
  // would produce. One word changes in the mirror above, and all four services go to one instance PER
  // LOCATION: measured 2026-07-28 as 4 real SQLite `Database` connections (the root graph's one plus
  // one per location); Global/Cipher are now also needed by the root SettingsConfigStore, so they
  // measure 4 as well, while Memory/Scheduler exist only in the three location halves.
  // A guard that cannot be shown to bite is not a guard.
  test("goes red with the exact per-service message when the global half is built unshared", async () => {
    const measured = await measure((replacements) => mirrorLocationServiceMap(replacements, { freshGlobals: true }))
    expect(violations(measured)).toEqual([
      "@novaclaw/v2/storage/Database: expected exactly 1 build and 1 instance per process, got 4 builds and 4 distinct instances across 3 locations",
      "@novaclaw/Global: expected exactly 1 build and 1 instance per process, got 4 builds and 4 distinct instances across 3 locations",
      "@novaclaw/v2/CredentialCipher: expected exactly 1 build and 1 instance per process, got 4 builds and 4 distinct instances across 3 locations",
      "@novaclaw/v2/MemoryClient: expected exactly 1 build and 1 instance per process, got 3 builds and 3 distinct instances across 3 locations",
      "@novaclaw/v2/SessionScheduler: expected exactly 1 build and 1 instance per process, got 3 builds and 3 distinct instances across 3 locations",
    ])
  }, 20000)
})
