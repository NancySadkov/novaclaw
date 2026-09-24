import { describe, expect } from "bun:test"
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentWorkerCapacity } from "@novaclaw/core/agent/worker-capacity"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandV2 } from "@novaclaw/core/command"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { PluginV2 } from "@novaclaw/core/plugin"
import { Reference } from "@novaclaw/core/reference"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Scratch } from "@novaclaw/core/scratch"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// v0.2.0-prep B7 / ruling 3 — an edited agent · command · reference · skill takes effect WITHOUT a
// reboot.
//
// These four are the domains that are neither a frozen value (Offline) nor an OS subscription (the
// watcher) but a MATERIALISED graph: `config/plugin/{agent,command,reference,skill}.ts` register a
// `ctx.<domain>.transform(...)` at location boot, and `state.ts` re-runs a transform only on an
// explicit `.reload()`. Nothing on the config-write path called one — so the ONLY thing that made an
// edited agent take effect was the whole layer graph being destroyed (`markInstanceForDisposal`),
// which is exactly the teardown B7 exists to delete. Dropping it before this landed would have
// turned "edit an agent in Settings" into a silent no-op until restart: the same defect shape B7
// removes, shipped as a regression CAUSED by the fix.
//
// The seam is `ConfigStoreWrite.apply` for the reasons written at that call site: after the
// transaction commits, and the ONE place every config write lands (the two HTTP handlers are not the
// only writers — the `configure` tool is coming). `Offline.reload` and `Watcher.reload` already ride
// it; this is the third cure at the same chokepoint.
//
// ⚠️ The shape that makes this a READ-THROUGH test rather than a rebuild test (the local precedent
// is `config-read-through.test.ts`): every domain service is resolved ONCE, before the write, and
// every assertion afterwards goes through that same instance. Re-resolving after the write would
// pass even with the domain frozen at boot.
// ────────────────────────────────────────────────────────────────────────────────────────────────

// Nothing here wants a real OS watch; the watcher has its own wiring test.
const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" }),
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
      LocationServiceMap.node,
    ]),
  ).pipe(Layer.provide(flagsLayer)),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

/** No `/`, whitespace, backtick or comma — `ConfigReference.validAlias` rejects those. */
const PROBE = "wired-through-the-write"

const withLocation = <A, E, R>(body: (location: Location.Ref, directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }), dir.path)))

describe("a config write re-materialises the domain it edited", () => {
  it.live("worker capacity changes reach the live officer capability before Save returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes: AgentWorkerCapacity.Change[] = []
        yield* AgentWorkerCapacity.register((change) => Effect.sync(() => void changes.push(change)))
        yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { maxWorkers: 3 } } }))
        expect(changes).toEqual([{ agentID: PROBE, limit: 3 }])
        yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { maxWorkers: 2 } } }))
        expect(changes).toEqual([
          { agentID: PROBE, limit: 3 },
          { agentID: PROBE, limit: 2 },
        ])
        yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { maxWorkers: 4 } } }))
        expect(changes).toHaveLength(2)
      }),
    ),
  )

  it.live("an edited AGENT is live on the same AgentV2 instance — no layer rebuild", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          // `ready` is the boot latch: `PluginInternal` forks its registration batch, and the
          // State reloads are deferred to the END of that batch. Waiting on it is how we know the
          // initial materialisation has settled before we measure — not a sleep.
          const plugins = yield* PluginV2.Service
          yield* plugins.ready

          // Resolved ONCE. See the read-through note at the top of the file.
          const agents = yield* AgentV2.Service
          const id = AgentV2.ID.make(PROBE)
          expect(yield* agents.get(id)).toBeUndefined()

          const dispatchedBefore = ConfigStoreWrite.reloadsDispatched("agents")
          expect(ConfigStoreWrite.registeredReloads("agents")).toBeGreaterThan(0)

          // The exact path `PATCH /config`, Settings → Import and (soon) the `configure` tool take.
          // Nothing is rebuilt after it, and no location is reopened.
          const started = performance.now()
          yield* ConfigStoreWrite.apply(
            decodeInfo({ agents: { [PROBE]: { description: "an agent edited at runtime" } } }),
          )
          const elapsed = performance.now() - started

          expect((yield* agents.get(id))?.description).toBe("an agent edited at runtime")

          // A SECOND edit of the same agent must also land — a reload that only ever runs once
          // (or a materialisation that caches) passes the assertion above and fails here.
          yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { description: "edited again" } } }))
          expect((yield* agents.get(id))?.description).toBe("edited again")

          // …and exactly one reload per write per location: the guard is per-key, not per-write.
          expect(ConfigStoreWrite.reloadsDispatched("agents") - dispatchedBefore).toBe(2)

          // The measured cost of the whole write + re-materialise, so "is a reload cheap enough to
          // wire onto every config write?" is answered by a number instead of an opinion. Printed,
          // deliberately NOT asserted: a wall-clock ceiling loose enough not to flake on a loaded
          // box (this location's whole boot is ~1 s) is also loose enough to pass if someone wired a
          // full location rebuild into the reload path — a guard-shaped no-op. The assertion that
          // actually catches that regression is the dispatch count above: one reload per write per
          // location, no fan-out to domains the write did not touch.
          console.log(`[measure] config write + agents re-materialise: ${elapsed.toFixed(1)} ms`)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )

  it.live("an edited COMMAND and REFERENCE are live on their same service instances", () =>
    Effect.scoped(
      withLocation((location, directory) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          yield* plugins.ready

          // Both resolved ONCE, before any write.
          const commands = yield* CommandV2.Service
          const references = yield* Reference.Service

          expect(yield* commands.get(PROBE)).toBeUndefined()
          expect((yield* references.list()).map((entry) => entry.name)).not.toContain(PROBE)

          yield* ConfigStoreWrite.apply(
            decodeInfo({ commands: { [PROBE]: { template: "run the probe", description: "a probe" } } }),
          )
          expect((yield* commands.get(PROBE))?.template).toBe("run the probe")

          // The OBJECT form on purpose: `config/plugin/reference.ts` classes a bare string as local
          // only when it starts with `.`, `/` or `~`, so a Windows `C:\…` string would be read as a
          // git repository. A `{ path }` entry is local on every platform.
          yield* ConfigStoreWrite.apply(decodeInfo({ references: { [PROBE]: { path: directory } } }))
          expect((yield* references.list()).map((entry) => String(entry.name))).toContain(PROBE)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )
})

describe("the reload guard is per-key, and a failed reload is described honestly", () => {
  it.effect("an unrelated config key re-materialises nothing", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      for (const domain of ConfigStoreWrite.RELOAD_DOMAINS)
        yield* ConfigStoreWrite.registerReload(domain, () =>
          Effect.sync(() => {
            seen.push(domain)
          }),
        )

      // `tool_output` is a settings key that routes through the same transaction as `agents` does. A
      // reload fired on "something was written" rather than on the key would show up here — and for
      // `references` that is not merely wasteful, it is a git fetch per remote alias on every
      // unrelated preference save. That is the bug the per-key guard exists to avoid.
      yield* ConfigStoreWrite.apply(decodeInfo({ tool_output: { max_lines: 17 } }))
      expect(seen).toEqual([])

      yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { description: "d" } } }))
      expect(seen).toEqual(["agents"])

      // `permissions` is not an agent key, but `config/plugin/agent.ts` folds the global ruleset
      // into EVERY agent at materialisation time — so an edited global rule is frozen into agent
      // state exactly the way an edited agent is, and it has to re-materialise too.
      yield* ConfigStoreWrite.apply(decodeInfo({ permissions: [{ action: "read", resource: "*", effect: "allow" }] }))
      expect(seen).toEqual(["agents", "agents"])
    }),
  )

  it.effect("a failed reload keeps the write DURABLE, says so by name, and still refreshes siblings", () =>
    Effect.gen(function* () {
      let sibling = 0
      yield* ConfigStoreWrite.registerReload("agents", () => Effect.die(new Error("materialise exploded")))
      yield* ConfigStoreWrite.registerReload("agents", () =>
        Effect.sync(() => {
          sibling++
        }),
      )

      const exit = yield* ConfigStoreWrite.apply(decodeInfo({ agents: { [PROBE]: { description: "durable" } } })).pipe(
        Effect.exit,
      )

      // Ruling 2 — the mutation did not fully take effect, so it must not report success…
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "<the write SUCCEEDED>"
      // …and the fault is not described falsely either: "it failed" would be a lie about a write
      // that is already committed, so the message says COMMITTED-but-not-live and names the domain.
      expect(message).toContain("COMMITTED")
      expect(message).toContain("agents")

      // One broken registration must not cost the others their refresh.
      expect(sibling).toBe(1)

      // …and the write really is durable — it is readable from the store the transaction committed
      // to, which is what makes "saved but not live" the honest description rather than a hedge.
      const store = yield* AgentConfigStore.Service
      expect((yield* store.agents())[PROBE]?.at(-1)?.description).toBe("durable")
    }),
  )
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE RELOAD HOOK, NOT THE HELPER. `agent-scratch-pairing.test.ts` proves `ownScratchGrants` computes
// the right ruleset; it cannot prove the agents door CALLS it, and the call is inline in this hook
// body (`config/plugin/agent.ts`, right after `agent.permissions.push(...item.permissions)`), so no
// helper-level test reaches it. That line is what will enforce containment in the first build that
// ships it, which makes an untested wiring line in a security rule the exact shape this comes back in.
//
// The discriminating half is the STRIP. `floor` only ever ADDS grants, so a materialized agent that
// carries no foreign scratch grant can only be the work of the wiring line. The GRANT half is weaker
// by construction — `floor({ scratchDirs: scratchDirsFor(id) })` may supply it when the agent is new
// — so it is asserted on a SECOND write of an agent that already exists, where the floor is skipped.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("the agents reload hook derives the scratch grant instead of carrying it", () => {
  const OFFICER = "scratch-door-probe"

  it.live("a stored layer naming ANOTHER officer's scratch is rewritten by the hook, not by the writer", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          yield* plugins.ready
          const agents = yield* AgentV2.Service
          const store = yield* AgentConfigStore.Service
          const id = AgentV2.ID.make(OFFICER)
          const own = `${Scratch.forAgent(OFFICER).replaceAll("\\", "/")}/*`
          const foreign = own.replace(`/${OFFICER}/*`, "/some-colleague/*")
          const grant = (resource: string) => [
            { action: "external_directory_read" as const, resource, effect: "allow" as const },
            { action: "external_directory_write" as const, resource, effect: "allow" as const },
          ]

          // The exact residue the clone writer left on a live instance 2026-09-10: a stored layer whose
          // scratch grant names a DIFFERENT agent, written through the one path every config write
          // takes. Nothing is rebuilt after it.
          yield* ConfigStoreWrite.apply(
            decodeInfo({ agents: { [OFFICER]: { description: "first write", permissions: grant(foreign) } } }),
          )

          const held = (yield* store.agents())[OFFICER]?.flatMap((layer) => layer.permissions ?? []) ?? []
          const materialized = (yield* agents.get(id))?.permissions ?? []
          const resources = materialized.map((rule) => String(rule.resource))

          // NEGATIVE CONTROL: the row really does carry the foreign grant. Without this, "the
          // materialized agent has no foreign grant" is satisfiable by a fixture that never had one.
          expect(held.map((rule) => String(rule.resource).replaceAll("\\", "/"))).toContain(foreign)
          // THE STRIP — the assertion only the wiring line can satisfy.
          expect(resources.some((resource) => resource.includes("scratch/some-colleague"))).toBe(false)
          expect(resources.map((resource) => resource.replaceAll("\\", "/"))).toContain(own)

          // A SECOND write, now that the agent exists: the floor is skipped for an agent already in the
          // draft, so if the own grant still shows up it came from the hook re-deriving it, not from
          // boot-time floor. The foreign grant is planted again to prove the strip is per-reload.
          yield* ConfigStoreWrite.apply(
            decodeInfo({ agents: { [OFFICER]: { description: "second write", permissions: grant(foreign) } } }),
          )
          const again = (yield* agents.get(id))?.permissions.map((rule) => String(rule.resource)) ?? []
          expect(again.some((resource) => resource.includes("scratch/some-colleague"))).toBe(false)
          expect(again.map((resource) => resource.replaceAll("\\", "/"))).toContain(own)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )
})
