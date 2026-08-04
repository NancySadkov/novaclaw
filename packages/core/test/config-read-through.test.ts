import { describe, expect } from "bun:test"
import { Effect } from "effect"
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

// v0.2.0 B7 tier-1 / ruling 3: "Read every runtime-editable value through to its store at the point
// of use; a settings change is not a reboot."
//
// `Config.entries()` used to project the settings store ONCE at `Layer.effect` scope and hand back
// the same frozen array for the life of the location. That is why AGENTS.md carried a "restart the
// serve after config changes" caveat, and why `tool/bash.ts` grew its own live-store read with the
// comment "Read the LIVE settings store, NOT config.entries() — location config is snapshotted".
// Ruling 3 deletes that caveat rather than documenting it.
//
// The invariant below is exactly the one whose violation compiles green: hoisting the read back to
// layer scope changes nothing a type or a name would catch — the same service, the same call, a
// stale answer.

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

describe("Config.entries reads through to the store", () => {
  it.live("a settings write is visible to the NEXT call on the SAME service — no layer rebuild", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* Effect.gen(function* () {
            // Resolved ONCE. Everything below runs against this one instance, which is what makes
            // this a read-through test rather than a rebuild test — re-resolving `Config.Service`
            // after the write would pass even with the value frozen at construction.
            const config = yield* Config.Service

            const before = Config.latest(yield* config.entries(), "shell")
            expect(before).not.toBe("/bin/read-through-probe")

            yield* store.set("shell", "/bin/read-through-probe")

            const after = Config.latest(yield* config.entries(), "shell")
            expect(after).toBe("/bin/read-through-probe")
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("a REMOVED setting falls back on the next call, so read-through is not write-only", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            yield* store.set("shell", "/bin/transient")
            expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/transient")

            // A cache keyed on "have I read yet" would pass the write test and fail this one.
            yield* store.remove("shell")
            expect(Config.latest(yield* config.entries(), "shell")).not.toBe("/bin/transient")
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )
})
