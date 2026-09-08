export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { HostPluginContext as PluginContext } from "@novaclaw/plugin/v2/effect"
import { Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { AgentConfigStore } from "../agent-config-store"
import { CatalogStore } from "../catalog-store"
import { CommandConfigStore } from "../command-config-store"
import { ReferenceConfigStore } from "../reference-config-store"
import { SettingsConfigStore } from "../settings-config-store"
import { SkillConfigStore } from "../skill-config-store"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigExternalPlugin } from "../config/plugin/external"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { EventV2 } from "../event"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { PluginV2 } from "../plugin"
import { Reference } from "../reference"
import { SkillV2 } from "../skill"
import { State } from "../state"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ModelsDevPlugin } from "./models-dev"
import { VariantPlugin } from "./variant"

/**
 * ⚠️ **`FileSystem` and `HttpClient` left this union on 2026-09-04, and neither was a capability
 * anyone was using.** Measured across all fourteen plugin files: not one references either, by any
 * spelling — the only hits were the word "filesystem" in two prose comments. Removing them from
 * PLUGIN scope is provably inert for resolution (nothing's `R` required them) and narrows the
 * contract, which is the direction this seam has to move.
 *
 * 🔴 The LAYER still merges `FileSystem.locationLayer` and `FetchHttpClient.layer` below, and must:
 * the services in this layer fetch and read on their own account. What changed is that a plugin no
 * longer receives ambient filesystem and network handles it never asked for — `HttpClient` in
 * particular is data-plane egress handed to in-process third-party code by default, in a product
 * whose data plane is meant to be airgappable (principle 4).
 *
 * 🔴 **Seven more left on 2026-09-04, and they were DUPLICATES rather than grants.** `AgentV2`,
 * `Catalog`, `CommandV2`, `EventV2`, `Integration`, `Reference` and `SkillV2` were provided here AND
 * handed to every plugin as `ctx` — `PluginHost.make` resolves each one and builds the context object
 * out of them. No plugin ever `yield*`ed them; every one reaches those capabilities through `ctx`,
 * which is the third channel and the one that actually carries them. So this list is now the six a
 * plugin genuinely resolves — `CatalogStore`, `Config`, `FSUtil`, `Global`, `Location`, `ModelsDev` —
 * measured against the declarations in `capabilities`, not guessed.
 *
 * ⚠️ **THREE channels, then, not two:** this per-plugin block, the ambient node `deps`, and the `ctx`
 * object. A plugin cannot tell the first two apart from the inside and does not need to; `ctx` is the
 * one that looks different and is therefore the one people notice. Counting only the first was what
 * made this list look like thirteen grants when six of them were real and seven were shadows.
 *
 * ⚠️ This is the SAFE half of the narrowing. The unsafe half — provide each plugin only what it
 * declares — is a different job, because a second provisioning channel exists: this node's `deps`
 * carry `AgentConfigStore`, `CommandConfigStore`, `ReferenceConfigStore`, `SkillConfigStore` and
 * more, which plugins reach ambiently and which are NOT in this union. `define<R>` leaves `R`
 * unconstrained, so a plugin may require anything and typecheck; whether it resolves depends on
 * which channel carries it. Removing a service NOTHING requires cannot break that. Narrowing per
 * plugin can, at BOOT, because these run at startup.
 */
export type Requirements =
  | AgentConfigStore.Service
  | CatalogStore.Service
  | CommandConfigStore.Service
  | Config.Service
  | FSUtil.Service
  | Global.Service
  | Location.Service
  | ModelsDev.Service
  | ReferenceConfigStore.Service
  | SkillConfigStore.Service

/**
 * ⚠️ **`Npm.Service` is deliberately NOT in this union** (removed 2026-09-04). Ruling 5 deleted the
 * arm that took a package name from config, fetched it with `npm.add` and `import()`ed the result —
 * *"remote code at this process's privilege"* — and named MCP as THE out-of-process extension seam.
 * The fetching arm went; the capability stayed injected here for weeks, spent by no plugin in the
 * tree. Granting third-party in-process code the ability to install packages is the retired arm
 * rebuilt one call at a time, and it is data-plane egress in a product whose data plane is meant to
 * be airgappable (principle 4).
 *
 * 🔴 **Adding a service to this union is a widening of what EVERY plugin may do**, first-party and
 * third-party alike, because the host provides the whole union unconditionally — `R` narrows what a
 * plugin *declares*, and types are erased before anything runs. That gap is the subject of its own
 * refactor item; until it closes, treat this list as the real permission surface for plugins and add
 * to it the way you would add a permission, not the way you would add an import.
 */
/**
 * 🔴 **What a plugin may reach, named at runtime rather than only in a type.**
 *
 * `Plugin<R>` already declares requirements in `R` — and `R` is erased before anything runs, so the
 * host provided every service to every plugin regardless, and nothing could tell a user what a
 * plugin had asked for. That is the gap: authority that cannot be enumerated cannot be narrowed
 * (the org metaphor's *authority narrows downward*), cannot be shown (12(d), *say what is in force*),
 * and cannot be moved behind a boundary later.
 *
 * ⚠️ **This list spans BOTH provisioning channels on purpose**, because the split is invisible from a
 * plugin's side and is exactly what makes the next step dangerous. Some of these are handed over per
 * plugin by `add` below; the config stores arrive ambiently through this node's `deps`. A plugin
 * `yield*`s them identically and cannot tell which is which.
 *
 * ⚠️ **Declaring is not yet enforcing.** Nothing here changes what the host provides — this step
 * makes the declaration exist and be checkable, and `core/test/plugin-capability-declaration.test.ts`
 * fails when a plugin's declaration disagrees with what its source actually uses. Narrowing
 * provisioning to the declared set comes after the declarations are proven honest, one channel at a
 * time, because these plugins run at STARTUP: getting it wrong is a failed boot, not a red test.
 */
export const CAPABILITIES = [
  "agent",
  "agentConfigStore",
  "catalog",
  "catalogStore",
  "command",
  "commandConfigStore",
  "config",
  "event",
  "fsUtil",
  "global",
  "integration",
  "location",
  "modelsDev",
  "reference",
  "referenceConfigStore",
  "skill",
  "skillConfigStore",
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * The service each capability names, spelled as it appears in a plugin's source.
 *
 * ⚠️ Kept beside the list rather than derived from the tags: the checker is a SOURCE scan (a plugin
 * is a file long before it is a live layer), so what it needs is the identifier a reader would type,
 * not the runtime tag. `plugin-capability-declaration.test.ts` fails if this map and `CAPABILITIES`
 * ever disagree, so the pair cannot drift.
 */
export const CAPABILITY_SERVICE: Readonly<Record<Capability, string>> = {
  agent: "AgentV2",
  agentConfigStore: "AgentConfigStore",
  catalog: "Catalog",
  catalogStore: "CatalogStore",
  command: "CommandV2",
  commandConfigStore: "CommandConfigStore",
  config: "Config",
  event: "EventV2",
  fsUtil: "FSUtil",
  global: "Global",
  integration: "Integration",
  location: "Location",
  modelsDev: "ModelsDev",
  reference: "Reference",
  referenceConfigStore: "ReferenceConfigStore",
  skill: "SkillV2",
  skillConfigStore: "SkillConfigStore",
}

export interface Plugin<R = never> {
  readonly id: string
  /**
   * Every capability this plugin reaches, named. REQUIRED — a plugin that declares nothing is
   * indistinguishable from one that needs nothing, and the whole point is that the difference
   * becomes visible. `[]` is a legitimate answer and `variant.ts` gives it.
   */
  readonly capabilities: readonly Capability[]
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalogStore = yield* CatalogStore.Service
    const plugin = yield* PluginV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    // The four config stores were reached AMBIENTLY until 2026-09-04 — present in this node's deps
    // and never provided per plugin, so a plugin resolved them without anything saying it could.
    // Resolving them here makes the second channel explicit; the services are identical and already
    // in this layer's environment, so nothing about what runs changes.
    const agentConfigStore = yield* AgentConfigStore.Service
    const commandConfigStore = yield* CommandConfigStore.Service
    const referenceConfigStore = yield* ReferenceConfigStore.Service
    const skillConfigStore = yield* SkillConfigStore.Service
    // ⚠️ `R` is CONSTRAINED here, and that constraint is the whole point of narrowing the list
    // above. `define<R>` still accepts anything (see its own note), but nothing may be ADDED whose
    // requirements this block does not satisfy — so the compiler, not a boot, is what tells you the
    // provision and the plugins have drifted apart.
    const add = <R extends Requirements | Scope.Scope>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        capabilities: input.capabilities,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(CatalogStore.Service, catalogStore),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelsDev.Service, modelsDev),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(Global.Service, global),
              Effect.provideService(AgentConfigStore.Service, agentConfigStore),
              Effect.provideService(CommandConfigStore.Service, commandConfigStore),
              Effect.provideService(ReferenceConfigStore.Service, referenceConfigStore),
              Effect.provideService(SkillConfigStore.Service, skillConfigStore),
            ),
      }
      // The declaration travels with the plugin. `capabilities` is REQUIRED on an internal plugin
      // and cross-checked against its source by `plugin-capability-declaration.test.ts`, so what the
      // disclosure surface shows for a built-in is a checked statement rather than a claim — unlike
      // an external plugin's, which is only ever what its author wrote.
      return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect, {
        capabilities: loaded.capabilities,
        source: "internal",
      })
    }

    yield* State.batch(
      Effect.gen(function* () {
        yield* add(ConfigReferencePlugin.Plugin)
        yield* add(AgentPlugin.Plugin)
        yield* add(CommandPlugin.Plugin)
        yield* add(ModelsDevPlugin)
        yield* add(ConfigAgentPlugin.Plugin)
        yield* add(ConfigCommandPlugin.Plugin)
        yield* add(ConfigSkillPlugin.Plugin)
        yield* add(ConfigExternalPlugin.Plugin)
        yield* add(ConfigProviderPlugin.Plugin)
        yield* add(VariantPlugin.Plugin)
      }),
    ).pipe(
      // The batch defers every State reload to its end — only AFTER it returns is the
      // catalog/agent/… state materialized. `plugin.markReady` opens the boot latch a
      // first-prompt-after-boot consumer (the session-runner model resolver) can await
      // instead of racing this fork (the "model unavailable right after boot" race).
      Effect.andThen(plugin.markReady),
      Effect.withSpan("PluginInternal.boot"),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(PluginV2.locationLayer),
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FileSystem.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)

export const node = makeLocationNode({
  name: "plugin-internal",
  layer,
  deps: [
    AgentConfigStore.node,
    Catalog.node,
    CatalogStore.node,
    CommandConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
    CommandV2.node,
    PluginV2.node,
    Integration.node,
    AgentV2.node,
    Config.node,
    Location.node,
    ModelsDev.node,
    EventV2.node,
    FSUtil.node,
    FileSystem.node,
    Global.node,
    httpClient,
    SkillV2.node,
    Reference.node,
  ],
})
