import { afterEach, describe, expect } from "bun:test"
import os from "os"
import path from "path"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { Config } from "@novaclaw/core/config"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Ignore } from "@novaclaw/core/filesystem/ignore"
import { Watcher } from "@novaclaw/core/filesystem/watcher"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// v0.2.0 B7 tier-2 / ruling 3: "read every runtime-editable value through to its store at the point
// of use — a settings change is not a reboot."
//
// `watcher.ignore` is the case where a read-through is NOT enough, and that is a fact about the
// CONSUMER rather than about the value: the list is handed to `@parcel/watcher` when the
// subscription is established, and from then on the OS-level watch is what enforces it. There is no
// later point of use to read through to, so the cure is a re-SUBSCRIBE. Until this landed, the only
// thing that applied an edited ignore list was `markInstanceForDisposal` — tearing down terminals,
// pending asks and MCP children because a user changed a preference.
//
// ⚠️ The roadmap called the subscriber chokidar. It is `@parcel/watcher` 2.5.1 (`w.subscribe(dir,
// callback, { ignore, backend })`); chokidar is in `bun.lock` only as a transitive dep of the
// unrelated `c12` config loader and is imported nowhere in `packages/core/src/filesystem/`.
//
// These tests drive the SUBSCRIPTION SEAM, not the filesystem: the layer subscribes through a stand-
// in binding (`Watcher.setBindingForTest`), so every assertion is about the exact ignore list handed
// to parcel and the exact set of subscriptions left alive — no wall-clock wait, and the failing
// re-subscribe below is not reachable against the real binding at all. The real binding stays
// covered end-to-end by `watcher.test.ts`.
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FakeSubscription = { readonly directory: string; readonly ignore: string[]; live: boolean }

class FakeParcel {
  readonly calls: FakeSubscription[] = []
  /** Set to make the NEXT subscribe reject, the way parcel does when a directory cannot be watched. */
  failNext = false

  get liveCalls() {
    return this.calls.filter((call) => call.live)
  }

  readonly binding = {
    subscribe: async (directory: string, _callback: unknown, options?: { ignore?: string[] }) => {
      if (this.failNext) {
        this.failNext = false
        throw new Error("parcel: refused to watch")
      }
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

/** A `Config.Service` whose `watcher.ignore` can be edited between calls — the store, in miniature. */
function mutableConfig() {
  const state = { ignore: [] as string[] }
  const decode = Schema.decodeUnknownSync(Config.Document)
  const layer = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([decode({ type: "document", info: { watcher: { ignore: state.ignore } } })]),
    }),
  )
  return { state, layer }
}

const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    NOVACLAW_EXPERIMENTAL_FILEWATCHER: "true",
    NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

// Never created on disk, and never needs to be: the stand-in binding does no I/O, the location has
// no vcs (so the git arm is inert), and `Protected.paths()` resolves under the home rather than here.
const DIRECTORY = path.join(os.tmpdir(), "novaclaw-watcher-config-reload")

function provide(fake: FakeParcel, config: Layer.Layer<Config.Service>) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(DIRECTORY) })),
  )
  Watcher.setBindingForTest(fake.binding as unknown as Parameters<typeof Watcher.setBindingForTest>[0])
  return Effect.provide(
    AppNodeBuilder.build(Watcher.node, [
      [Config.node, config],
      [Location.node, locationLayer],
    ]).pipe(Layer.provide(flagsLayer)),
  )
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))

afterEach(() => {
  Watcher.setBindingForTest(undefined)
})

/**
 * `Watcher.reload()` awaits each live watcher's reconcile under its permit, so once it returns the
 * subscription set is settled — including the FIRST subscribe, which the layer forks so that a
 * location boot never blocks on the OS establishing a watch. Whichever of the two runs second finds
 * nothing to do, because the plan is computed from the store rather than from "something wrote".
 */
const settled = Watcher.reload

describe("Watcher re-subscribes when watcher.ignore changes", () => {
  it.effect("a live edit to watcher.ignore is in force with no layer rebuild", () => {
    const fake = new FakeParcel()
    const config = mutableConfig()
    return Effect.gen(function* () {
      yield* settled()
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]!.directory).toBe(DIRECTORY)
      // The compiled defaults lead the list, and nothing from config is in it yet.
      expect(fake.calls[0]!.ignore.slice(0, Ignore.PATTERNS.length)).toEqual(Ignore.PATTERNS)
      expect(fake.calls[0]!.ignore).not.toContain("build-output/**")

      // The whole point: edit the value the way a Settings toggle does, and ask for it to apply.
      config.state.ignore = ["build-output/**"]
      yield* settled()

      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]!.ignore).toContain("build-output/**")
      // The defaults are still there — a re-subscribe must rebuild the WHOLE list, not swap it.
      expect(fake.calls[1]!.ignore.slice(0, Ignore.PATTERNS.length)).toEqual(Ignore.PATTERNS)
      // …and exactly one watch is in force, the new one.
      expect(fake.liveCalls).toEqual([fake.calls[1]!])
    }).pipe(provide(fake, config.layer))
  })

  it.effect("three config changes leave exactly one live subscription", () => {
    const fake = new FakeParcel()
    const config = mutableConfig()
    return Effect.gen(function* () {
      const created = Watcher.subscriptionsCreated()
      const live = Watcher.liveSubscriptions()
      yield* settled()

      for (const pattern of ["a/**", "b/**", "c/**"]) {
        config.state.ignore = [pattern]
        yield* settled()
      }

      // Four subscribes (the initial one plus one per change) and three releases. A re-subscribe
      // that forgets to release its predecessor leaves an OS watch nobody will ever unsubscribe and
      // a duplicate event stream — which is invisible to an ignore-list assertion, and is exactly
      // what this count is here to catch.
      expect(Watcher.subscriptionsCreated() - created).toBe(4)
      expect(fake.calls).toHaveLength(4)
      expect(Watcher.liveSubscriptions() - live).toBe(1)
      // The module's own count, checked against the stand-in's ground truth — a counter that can lie
      // about the thing it counts is worse than no counter.
      expect(fake.liveCalls).toEqual([fake.calls[3]!])
      expect(fake.calls[3]!.ignore).toContain("c/**")
    }).pipe(provide(fake, config.layer))
  })

  it.effect("a reload whose ignore list did not change re-subscribes nothing", () => {
    const fake = new FakeParcel()
    const config = mutableConfig()
    return Effect.gen(function* () {
      yield* settled()
      expect(fake.calls).toHaveLength(1)

      // A settings write is instance-wide and fans out to every location, so most reloads a watcher
      // sees are about some other key entirely. Those must cost a store read and nothing else:
      // re-subscribing on every config write would drop events for a preference that never touched
      // the watcher.
      yield* settled()
      yield* settled()
      expect(fake.calls).toHaveLength(1)
      expect(fake.liveCalls).toHaveLength(1)
    }).pipe(provide(fake, config.layer))
  })

  it.effect("a FAILED re-subscribe keeps the previous subscription, and names what is in force", () => {
    const fake = new FakeParcel()
    const config = mutableConfig()
    return Effect.gen(function* () {
      yield* settled()
      const original = fake.calls[0]!

      // Ruling 2 — a failed mutation never reports success, and an unavailable subsystem names
      // itself. Of the two degradations, dropping the subscription is the worse one: the directory
      // would stop being watched entirely and no later reload would rebuild it, because a reload
      // with an unchanged config finds nothing to do.
      config.state.ignore = ["never-applied/**"]
      fake.failNext = true
      yield* settled()

      expect(fake.liveCalls).toEqual([original])
      expect(original.live).toBe(true)
      const logged = (yield* TestConsole.logLines).map((line) => JSON.stringify(line)).join("\n")
      expect(logged).toContain("re-subscribe failed")
      expect(logged).toContain("PREVIOUS ignore list is still in force")

      // And the failure poisons nothing: the next reload still applies the pending list, because the
      // plan is recomputed from the store rather than remembered.
      yield* settled()
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]!.ignore).toContain("never-applied/**")
      expect(fake.liveCalls).toEqual([fake.calls[1]!])
    }).pipe(provide(fake, config.layer))
  })

  it.effect("teardown releases every subscription, and a later reload cannot resurrect one", () => {
    const fake = new FakeParcel()
    const config = mutableConfig()
    return Effect.gen(function* () {
      const live = Watcher.liveSubscriptions()
      const registered = Watcher.registeredWatchers()
      yield* Effect.gen(function* () {
        yield* settled()
        config.state.ignore = ["gone/**"]
        yield* settled()
        expect(fake.liveCalls).toHaveLength(1)
      }).pipe(provide(fake, config.layer))

      // The scope finalizer releases whatever is CURRENT, not whatever was subscribed first.
      expect(fake.liveCalls).toEqual([])
      expect(Watcher.liveSubscriptions()).toBe(live)
      // …and the closed layer is no longer a fan-out target for the next config write.
      expect(Watcher.registeredWatchers()).toBe(registered)

      // A config write racing a location close must not re-subscribe into a layer that is gone:
      // that subscription would be owned by nobody and nothing would ever release it.
      yield* settled()
      expect(fake.calls).toHaveLength(2)
      expect(fake.liveCalls).toEqual([])
      expect(Watcher.liveSubscriptions()).toBe(live)
    })
  })
})
