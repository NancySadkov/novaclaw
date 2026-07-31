import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Watcher } from "@novaclaw/core/filesystem/watcher"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// v0.2.0 B7 tier-2 — the TRIGGER, not the mechanism.
//
// `watcher-config-reload.test.ts` proves that `Watcher.reload()` recomputes the plan and re-subscribes
// correctly. This file proves the only thing that file cannot: that anything ever CALLS it. Those are
// two different failures and only one of them is visible from inside the watcher — a reload that is
// perfect and unreachable is indistinguishable, from the user's side, from the frozen snapshot it
// replaced. Ruling 1: the invariant is "a config write applies", and an invariant with no mechanical
// check does not exist.
//
// The seam is `ConfigStoreWrite.apply`, chosen for the reasons written at that call site: it is AFTER
// the transaction commits, and it is the ONE place every config write lands — the two HTTP handlers
// are not the only writers (the v0.2.0 `configure` tool is coming), and an invariant duplicated
// across call sites is one a new caller forgets. `Offline.reload` rides the same chokepoint, and the
// pair is deliberate; what differs is the CURE, because Offline froze a value while the watcher
// handed its list to `@parcel/watcher` and cannot read through to a live subscription.
//
// This runs against the REAL store graph and the REAL `Config` read-through — only the OS-level
// subscriber is a stand-in, because the assertion is about which ignore list reached it.
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FakeSubscription = { readonly directory: string; readonly ignore: string[]; live: boolean }

class FakeParcel {
  readonly calls: FakeSubscription[] = []
  readonly binding = {
    subscribe: async (directory: string, _callback: unknown, options?: { ignore?: string[] }) => {
      const call: FakeSubscription = { directory, ignore: [...(options?.ignore ?? [])], live: true }
      this.calls.push(call)
      return {
        unsubscribe: async () => {
          call.live = false
        },
      }
    },
  }
}

// The root-directory watch is behind this flag, and it is the arm whose ignore list a user edits.
// ⚠️ Not dark in the product: `packages/desktop/src/main/server.ts` sets it for the sidecar, so the
// desktop app runs with this watch live. It is off only for the CLI and a bare `novaclaw serve`.
const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    NOVACLAW_EXPERIMENTAL_FILEWATCHER: "true",
    NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      CatalogStore.node,
      AgentConfigStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SkillConfigStore.node,
      PluginConfigStore.node,
      LocationServiceMap.node,
    ]),
  ).pipe(Layer.provide(flagsLayer)),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

describe("a config write reaches the watcher", () => {
  it.live("PATCH-ing watcher.ignore re-subscribes with the new list — no location reopen", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeParcel()
        Watcher.setBindingForTest(fake.binding as unknown as Parameters<typeof Watcher.setBindingForTest>[0])
        yield* Effect.addFinalizer(() => Effect.sync(() => Watcher.setBindingForTest(undefined)))

        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (handle) => Effect.promise(() => handle[Symbol.asyncDispose]()),
        )
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })

        yield* Effect.gen(function* () {
          // Resolving the service builds the layer, which forks the first subscribe. `reload()`
          // awaits each live watcher under its own permit, so this is how we know the initial
          // subscribe has settled before we measure — not a sleep.
          yield* Watcher.Service
          yield* Watcher.reload()

          const before = fake.calls.length
          expect(before, "the location's watch should be established").toBeGreaterThan(0)
          expect(fake.calls.at(-1)!.ignore).not.toContain("wired-through-the-write/**")

          // The exact path `PATCH /config` and Settings → Import take. Nothing is rebuilt after it.
          yield* ConfigStoreWrite.apply(decodeInfo({ watcher: { ignore: ["wired-through-the-write/**"] } }))

          expect(fake.calls.length, "the write must have caused a re-subscribe").toBeGreaterThan(before)
          expect(fake.calls.at(-1)!.ignore).toContain("wired-through-the-write/**")
          // …and it replaced rather than accumulated: exactly one watch per directory stays live.
          expect(fake.calls.filter((call) => call.live)).toEqual([fake.calls.at(-1)!])
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
      }),
    ),
  )

  it.live("a write that carries no `watcher` key does not churn the subscription", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeParcel()
        Watcher.setBindingForTest(fake.binding as unknown as Parameters<typeof Watcher.setBindingForTest>[0])
        yield* Effect.addFinalizer(() => Effect.sync(() => Watcher.setBindingForTest(undefined)))

        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (handle) => Effect.promise(() => handle[Symbol.asyncDispose]()),
        )
        const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })

        yield* Effect.gen(function* () {
          yield* Watcher.Service
          yield* Watcher.reload()
          const before = fake.calls.length

          // `shell` is a settings key like `watcher` is, and it routes through the same transaction.
          // The guard is `consumed.has("watcher")`, so this must cost nothing — a watch torn down and
          // rebuilt on every unrelated preference save would be the stop-the-world teardown B7 is
          // removing, wearing a smaller footprint.
          yield* ConfigStoreWrite.apply(decodeInfo({ shell: "/bin/wiring-probe" }))

          expect(fake.calls.length, "an unrelated config key must not re-subscribe").toBe(before)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
      }),
    ),
  )
})
