export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { PluginContext } from "@novaclaw/plugin/v2/effect"
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
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ModelsDevPlugin } from "./models-dev"
import { VariantPlugin } from "./variant"

export type Requirements =
  | AgentV2.Service
  | Catalog.Service
  | CatalogStore.Service
  | CommandV2.Service
  | Config.Service
  | EventV2.Service
  | FileSystem.Service
  | FSUtil.Service
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelsDev.Service
  | Reference.Service
  | SkillV2.Service

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
export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const catalogStore = yield* CatalogStore.Service
    const commands = yield* CommandV2.Service
    const plugin = yield* PluginV2.Service
    const integration = yield* Integration.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const skill = yield* SkillV2.Service
    const reference = yield* Reference.Service
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Catalog.Service, catalog),
              Effect.provideService(CatalogStore.Service, catalogStore),
              Effect.provideService(CommandV2.Service, commands),
              Effect.provideService(Integration.Service, integration),
              Effect.provideService(AgentV2.Service, agents),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelsDev.Service, modelsDev),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(Global.Service, global),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(SkillV2.Service, skill),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect)
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
