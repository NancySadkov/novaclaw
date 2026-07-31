import { describe, expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Database } from "@novaclaw/core/database/database"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Config } from "@/config/config"
import { Format } from "@/format"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"

/**
 * **v0.2.0-prep B7 tier-3 — a settings change is not a reboot, for the keys novaclaw reads.**
 *
 * ⚠️ The premise this file pins is one level below where the tier-2 note left it. Tier-2 recorded
 * that `mcp`, `formatter`, `snapshots` and `plugins` "still want a restart" and attributed it to five
 * named per-service `InstanceState` caches. Measured against the working tree, the real chain is:
 *
 *   `<service>.state` (per instance) ← built from → `Config.get()` ← `Config.state` (per instance)
 *   ← built from → `getGlobal()` (process-wide, no TTL) ← the SQLite stores
 *
 * — and the middle link is the one nothing ever refreshed. `Config.invalidate()` clears only the
 * process-global store view; the per-instance MERGED DOCUMENT stayed at its first-read value for the
 * life of the process, and the only thing that ever replaced it was the instance being destroyed
 * (`markInstanceForDisposal`). So `snapshots` was stale even though `snapshot/index.ts:170` re-reads
 * `config.get().snapshots` on every single call: the read was through, the document was not.
 *
 * Which is why the two tests below are the honest pair. `Config.get()` freshness IS the whole cure
 * for `snapshots` (there is no derived snapshot cache — the sixth cache at `snapshot/index.ts:67`
 * holds git paths, and no config value at all). `formatter` needs that PLUS its own derived table
 * re-built, which is the ordering `RELOAD_DOMAINS` encodes and
 * `packages/core/test/config-reload-order-ledger.test.ts` pins.
 *
 * ⚠️ **Both tests READ BEFORE THEY WRITE, and that is the entire experiment.** Reading first is what
 * populates the cache; a test that writes first and reads once passes against the unfixed code —
 * which is exactly how `test/config/config.test.ts`'s store-backed-serving cases have always passed
 * while this defect was live.
 *
 * NEGATIVE CONTROL (observed, see the report): deleting the `registerReload("instance_config", …)`
 * block in `src/config/config.ts` turns both tests red — `snapshots` reads back `true` instead of
 * `false`, and the formatter table still lists every built-in.
 */

/**
 * The config stores, resolved through the AMBIENT memo map so they are the SAME `Database.Service`
 * the graph under test reads. `test/preload.ts` sets `NOVACLAW_DB=":memory:"`, where every distinct
 * layer build is a private database — so building these any other way would write to a store nobody
 * is reading and the tests would pass vacuously. (Same construction, and the same reason, as
 * `test/fixture/fixture.ts`'s `applyConfigScoped`.)
 */
const configStores = LayerNode.compile(
  LayerNode.group([
    Database.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
  ]),
)

/** Write a patch the way `PATCH /config` does — the real chokepoint, reload fan-out included. */
const applyPatch = (patch: Record<string, unknown>) =>
  ConfigStoreWrite.apply(Schema.decodeUnknownSync(ConfigV2.Info)(patch)).pipe(Effect.provide(configStores))

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, Format.node])))

describe("B7 tier-3 — the merged instance document is refreshed by a config write", () => {
  it.instance(
    "`snapshots` is live after a write, with no instance teardown",
    () =>
      Effect.gen(function* () {
        // READ FIRST — this is what caches the document, and what the pre-fix code never replaced.
        expect((yield* Config.use.get()).snapshots).toBe(true)

        const before = ConfigStoreWrite.reloadsDispatched("instance_config")
        yield* applyPatch({ snapshots: false })

        // The value `snapshot/index.ts`'s `enabled()` reads on every call. Asserted BEFORE the
        // counter on purpose: under the negative control this is the line that has to speak, and a
        // counter assertion firing first would report "no reload was dispatched" — true, but one step
        // removed from the user-visible fact that the setting did not take.
        expect((yield* Config.use.get()).snapshots).toBe(false)
        expect(ConfigStoreWrite.reloadsDispatched("instance_config")).toBeGreaterThan(before)
      }),
    { config: { snapshots: true } },
  )

  it.instance(
    "an UNRELATED key costs the document nothing — the per-key discipline is real",
    () =>
      Effect.gen(function* () {
        yield* Config.use.get()
        const before = ConfigStoreWrite.reloadsDispatched("instance_config")
        const formatter = ConfigStoreWrite.reloadsDispatched("formatter")
        // `username` is a settings key no materialised domain derives from. A registry that fired on
        // "something was written" instead of on a trigger list would re-glob the config directories
        // (and re-fetch any remote well-known config) on every single save.
        yield* applyPatch({ username: "b7-tier3-probe" })
        expect(ConfigStoreWrite.reloadsDispatched("instance_config")).toBe(before)
        expect(ConfigStoreWrite.reloadsDispatched("formatter")).toBe(formatter)
      }),
    { config: { username: "before" } },
  )
})

describe("B7 tier-3 — a FAILED rebuild leaves the instance stale, never broken", () => {
  it.instance("the previous value survives and the failure is re-raised", () =>
    Effect.gen(function* () {
      // ⚠️ The hazard this pins is a property of `ScopedCache`, not of our code, which is why a
      // comment would not have held it: failed lookup exits are cached under the SAME infinite TTL
      // as successful ones, and `refresh` overwrites the entry with whichever exit it got. So a
      // rebuild that throws — a `.well-known` config source unreachable while the user saves a
      // preference — would replace a good document with a permanently cached failure, and every
      // later read for that instance would die. That is strictly worse than the staleness B7 cures.
      let attempt = 0
      const state = yield* InstanceState.makeRematerializable(() =>
        Effect.suspend(() => (attempt++ === 0 ? Effect.succeed("good") : Effect.fail("rebuild exploded"))),
      )
      expect(yield* InstanceState.get(state)).toBe("good")

      const exit = yield* Effect.exit(InstanceState.rematerializeAll(state))
      // Re-raised, so `ConfigStoreWrite.refreshDomains` reports "committed, not live" rather than
      // reporting a refresh that did not happen.
      expect(Exit.isFailure(exit)).toBe(true)
      // …and the instance still works, on the last known-good value.
      expect(yield* InstanceState.get(state)).toBe("good")
    }),
  )
})

describe("B7 tier-3 — the formatter table is re-derived by a config write", () => {
  it.instance(
    "turning formatters off in Settings applies without a restart",
    () =>
      Effect.gen(function* () {
        // Build the table while `formatter` is `true`: every built-in is registered. `init()` does
        // NOT probe the binaries — that happens lazily in `status()` — so this is cheap.
        yield* Format.use.init()
        expect(ConfigStoreWrite.registeredReloads("formatter")).toBeGreaterThan(0)

        const before = ConfigStoreWrite.reloadsDispatched("formatter")
        yield* applyPatch({ formatter: false })
        expect(ConfigStoreWrite.reloadsDispatched("formatter")).toBeGreaterThan(before)

        // `formatter: false` means "all formatters are disabled" — the table is empty and `status()`
        // probes nothing. Against the unfixed code this returns every built-in instead (and pays for
        // a PATH probe each, which is why the RED path here is also the slow one).
        expect(yield* Format.use.status()).toEqual([])
      }),
    { config: { formatter: true } },
  )
})
