import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Config } from "@novaclaw/core/config"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SettingsConfigStore } from "../src/settings-config-store"
import { ProfileTool } from "../src/tool/profile"
import { ToolRegistry } from "../src/tool/registry"
import { Tool } from "../src/tool/tool"
import { Tools } from "../src/tool/tools"

// v0.2.0 B7 tier-2a — the `profile` tool's registration gate was computed at LAYER scope, so
// switching profile sharing on in Settings did not put the tool on the model's horizon until the
// location reopened. That is todo.md ruling 3 (*a settings change is not a reboot*), and it is one of
// the two freezes that block removing `markInstanceForDisposal` from the config write path.
//
// The cure is a live, per-horizon availability predicate — `ToolRegistry.withAvailability`,
// evaluated inside `ToolRegistry.materialize` — rather than a hoisted read. `src/tool/profile.ts`
// carries the full design argument (why not execution-time refusal, why not a `Config` dependency in
// the registry, and why `hasContent` was dropped as a gate entirely).
//
// ⚠️ The invariant here is the kind whose violation compiles green: moving the read back up to layer
// scope is the same service, the same call and the same types — only a stale answer. So every check
// below resolves `ToolRegistry.Service` ONCE and re-materializes against that one instance. A test
// that re-resolved the service after the write would pass even with the value frozen at
// construction, and would therefore prove nothing.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SettingsConfigStore.node, LocationServiceMap.node]),
  ),
)

const withLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

/** The tool names the model would actually be offered right now, from ONE registry instance. */
const horizon = (registry: ToolRegistry.Interface) =>
  registry
    .materialize()
    .pipe(
      Effect.map((materialized) => [
        ...materialized.definitions.map(({ name }) => name),
        ...materialized.deferred.map((source) => source.definition.name),
      ]),
    )

/** A minimal tool value; only its presence on the horizon is ever inspected. */
const probeTool = () =>
  Tool.make({
    description: "availability probe",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
  })

describe("the profile tool's availability is live, not frozen at location open", () => {
  it.live("turning sharing ON in Settings reaches the horizon with NO layer rebuild", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* store.set("user_profile", { enabled: false, name: "Nancy" })
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect(yield* horizon(registry)).not.toContain("profile")

            yield* store.set("user_profile", { enabled: true, name: "Nancy" })

            expect(yield* horizon(registry)).toContain("profile")
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("turning sharing OFF withdraws it mid-location — the read is not write-once", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* store.set("user_profile", { enabled: true, name: "Nancy" })
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect(yield* horizon(registry)).toContain("profile")

            // A predicate memoized on "have I answered once" passes the test above and fails here.
            yield* store.set("user_profile", { enabled: false })

            expect(yield* horizon(registry)).not.toContain("profile")
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  // THE CONTROL for the two above: a tool that declares NO predicate must not move when the same
  // settings key changes. Without it, a `materialize` that returned an empty horizon — or one that
  // withdrew everything — would satisfy both tests above.
  it.live("a tool with no availability predicate is unaffected by the same settings write", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service

            yield* store.set("user_profile", { enabled: true, name: "Nancy" })
            const before = yield* horizon(registry)
            expect(before).toContain("read")

            yield* store.set("user_profile", { enabled: false })
            const after = yield* horizon(registry)
            expect(after).toContain("read")
            // Exactly one name moved, and it is the one that declared a predicate.
            expect(before.filter((entry) => !after.includes(entry))).toEqual(["profile"])
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("an EMPTY profile is still advertised — emptiness is the tool's OUTPUT, not its availability", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          // No `user_profile` row at all: the switch has never been touched, nothing is filled in.
          yield* store.remove("user_profile")
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            // The old gate ANDed `hasContent` into registration, so this case had no tool at all —
            // which made "the user forbade this" and "the user has not typed anything yet" the same
            // observation from the model's side. It is present now, and it answers honestly.
            expect(yield* horizon(registry)).toContain("profile")
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))

          expect(ProfileTool.toModelOutput({})).toBe("The user has not filled in any profile details yet.")
          expect(ProfileTool.toModelOutput({ name: "Nancy" })).toContain("Nancy")
        }),
      ),
    ),
  )
})

describe("ToolRegistry.withAvailability", () => {
  it.live("withdraws and restores a tool as its predicate answers, per materialization", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const tools = yield* Tools.Service
          const registry = yield* ToolRegistry.Service
          let available = true
          yield* tools
            .register({
              availability_probe: ToolRegistry.withAvailability(
                probeTool(),
                Effect.sync(() => available),
              ),
            })
            .pipe(Effect.orDie)

          expect(yield* horizon(registry)).toContain("availability_probe")
          available = false
          expect(yield* horizon(registry)).not.toContain("availability_probe")
          available = true
          expect(yield* horizon(registry)).toContain("availability_probe")
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )

  it.live("composes with Tool.withPermission when applied LAST, as registry.ts documents", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const tools = yield* Tools.Service
          const registry = yield* ToolRegistry.Service
          yield* tools
            .register({
              // The supported order: decorate the permission first, then attach availability to the
              // value that is actually registered.
              availability_after_permission: ToolRegistry.withAvailability(
                Tool.withPermission(probeTool(), "explore"),
                Effect.succeed(false),
              ),
              // ⚠️ The UNSUPPORTED order, pinned so the documented limitation stays honest:
              // `Tool.withPermission` copies the tool's runtime into a NEW object the availability
              // WeakMap has never seen, so the predicate is silently dropped. If this assertion ever
              // fails because the predicate now carries through, that is an improvement — delete the
              // ⚠️ ordering note in `registry.ts` along with this case.
              availability_before_permission: Tool.withPermission(
                ToolRegistry.withAvailability(probeTool(), Effect.succeed(false)),
                "explore",
              ),
            })
            .pipe(Effect.orDie)

          const names = yield* horizon(registry)
          expect(names).not.toContain("availability_after_permission")
          expect(names).toContain("availability_before_permission")
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )

  // ⚠️ `materialize` runs per TURN and per STEP (`session/runner/llm.ts`), so a predicate sits on a
  // hot path and the roadmap item required this to be MEASURED rather than assumed. The ceilings are
  // deliberately ~2 orders of magnitude above what a single-table SELECT costs: they exist to catch
  // somebody putting real I/O (a network call, a filesystem walk, a layer rebuild) behind a
  // predicate, not to police jitter on a loaded developer box.
  it.live("costs a query, not a rebuild — measured", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const registry = yield* ToolRegistry.Service
          const store = yield* SettingsConfigStore.Service
          yield* store.set("user_profile", { enabled: true, name: "Nancy" })

          const rounds = 50
          // Warm the SQLite statement cache and the per-name ToolDefinition memo first, so the
          // numbers describe the steady state a running session actually pays.
          for (let index = 0; index < 5; index++) yield* registry.materialize()

          const entriesStart = performance.now()
          for (let index = 0; index < rounds; index++) yield* config.entries()
          const perEntries = (performance.now() - entriesStart) / rounds

          const materializeStart = performance.now()
          for (let index = 0; index < rounds; index++) yield* registry.materialize()
          const perMaterialize = (performance.now() - materializeStart) / rounds

          const offered = (yield* horizon(registry)).length
          console.log(
            `[B7 tier-2a cost] Config.entries() ${perEntries.toFixed(3)} ms/call · ` +
              `ToolRegistry.materialize() ${perMaterialize.toFixed(3)} ms/call over ${offered} tools`,
          )
          expect(perEntries).toBeLessThan(10)
          expect(perMaterialize).toBeLessThan(25)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )
})
