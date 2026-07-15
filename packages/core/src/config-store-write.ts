export * as ConfigStoreWrite from "./config-store-write"

import { Effect, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigProvider } from "./config/provider"
import { PluginConfigSeed } from "./plugin-config-seed"
import { PluginConfigStore } from "./plugin-config-store"
import { ProviderV2 } from "./provider"
import { ReferenceConfigStore } from "./reference-config-store"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SettingsConfigStore } from "./settings-config-store"
import { SkillConfigStore } from "./skill-config-store"

// Config→SQLite step 7: the Settings-UI write router + read overlay. The app's
// `updateConfig` contract is patch-MERGE over the effective config; this module routes each
// top-level key of such a patch into its owning SQLite store — and mirrors the same keys back
// over the file-derived view so the UI reads what it wrote. Keys with no owning store yet
// (permissions, instructions, experimental, disabled/enabled_providers, …) are NOT consumed;
// the caller falls back to the legacy jsonc patch for them (removed in step 8).
//
// Merge semantics per store shape:
// - settings keys: one whole value per key — deep-merge the patch into the stored value
//   (objects merge, arrays replace wholesale — the documented updateConfig contract).
// - layered stores (providers/agents/commands/references): APPEND the patch fragment as a new
//   layer — layers apply in order, so appending reproduces patch-merge exactly.
// - list stores (skills/plugins): the config value is an array (replace-wholesale contract) —
//   the store content is replaced.

/** Deep patch-merge: objects merge recursively, arrays and primitives replace. */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (
    base === null ||
    patch === null ||
    typeof base !== "object" ||
    typeof patch !== "object" ||
    Array.isArray(base) ||
    Array.isArray(patch)
  ) {
    return patch
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? mergePatch(result[key], value) : value
  }
  return result
}

const encodeInfo = (info: Config.Info) => Schema.encodeSync(Config.Info)(info) as Record<string, unknown>

/**
 * Route one `updateConfig` patch into the SQLite stores. Returns the set of top-level keys
 * consumed; the caller handles the rest via the legacy jsonc path (until step 8).
 */
export const apply = (patch: Config.Info) =>
  Effect.gen(function* () {
    const consumed = new Set<string>()
    const plain = encodeInfo(patch)

    const settings = yield* SettingsConfigStore.Service
    const current = yield* settings.all()
    for (const key of SettingsConfigSeed.SETTINGS_KEYS) {
      const value = plain[key]
      if (value === undefined) continue
      yield* settings.set(key, mergePatch(current[key], value))
      consumed.add(key)
    }

    const catalog = yield* CatalogStore.Service
    if (patch.providers !== undefined) {
      const layers = yield* catalog.providers()
      for (const [id, fragment] of Object.entries(patch.providers)) {
        yield* catalog.setLayers(ProviderV2.ID.make(id), [...(layers[id] ?? []), fragment])
      }
      consumed.add("providers")
    }
    if (patch.model !== undefined) {
      yield* catalog.setDefault(patch.model)
      consumed.add("model")
    }

    const agents = yield* AgentConfigStore.Service
    if (patch.agents !== undefined) {
      const layers = yield* agents.agents()
      for (const [name, fragment] of Object.entries(patch.agents)) {
        yield* agents.setLayers(name, [...(layers[name] ?? []), fragment])
      }
      consumed.add("agents")
    }
    if (patch.default_agent !== undefined) {
      yield* agents.setDefault(patch.default_agent)
      consumed.add("default_agent")
    }

    if (patch.commands !== undefined) {
      const commands = yield* CommandConfigStore.Service
      const layers = yield* commands.commands()
      for (const [name, fragment] of Object.entries(patch.commands)) {
        yield* commands.setLayers(name, [...(layers[name] ?? []), fragment])
      }
      consumed.add("commands")
    }

    if (patch.references !== undefined) {
      const references = yield* ReferenceConfigStore.Service
      const layers = yield* references.references()
      for (const [name, fragment] of Object.entries(patch.references)) {
        yield* references.setLayers(name, [...(layers[name] ?? []), fragment])
      }
      consumed.add("references")
    }

    if (patch.skills !== undefined) {
      // Array key: replace wholesale. UI/import writes are expected to carry absolute paths
      // or URLs (there is no declaring file to resolve a relative entry against here).
      const skills = yield* SkillConfigStore.Service
      for (const source of yield* skills.sources()) yield* skills.removeSource(source)
      for (const item of patch.skills) yield* skills.addSource(item)
      consumed.add("skills")
    }

    if (patch.plugins !== undefined) {
      const plugins = yield* PluginConfigStore.Service
      for (const entry of yield* plugins.plugins()) yield* plugins.removePlugin(entry.package)
      for (const item of patch.plugins) yield* plugins.setPlugin(PluginConfigSeed.normalizePluginEntry("", item))
      consumed.add("plugins")
    }

    return consumed
  })

/**
 * Overlay the store-backed keys onto a file-derived config view (the /config GET responses),
 * so the Settings UI reads exactly what the router wrote. Folds layered stores with the same
 * patch-merge the runtime applies layer-by-layer.
 */
export const overlay = (base: Record<string, unknown>) =>
  Effect.gen(function* () {
    const result: Record<string, unknown> = { ...base }

    const settings = yield* SettingsConfigStore.Service
    for (const [key, value] of Object.entries(yield* settings.all())) {
      if (value !== undefined) result[key] = value
    }

    const catalog = yield* CatalogStore.Service
    const providerLayers = yield* catalog.providers()
    if (Object.keys(providerLayers).length > 0) {
      const encodeProvider = Schema.encodeSync(ConfigProvider.Info)
      const folded: Record<string, unknown> = {}
      for (const [id, layers] of Object.entries(providerLayers)) {
        folded[id] = layers.reduce<unknown>((merged, layer) => mergePatch(merged, encodeProvider(layer)), undefined)
      }
      result.providers = folded
    }
    const defaultModel = yield* catalog.getDefault()
    if (defaultModel !== undefined) result.model = defaultModel

    const agents = yield* AgentConfigStore.Service
    const defaultAgent = yield* agents.getDefault()
    if (defaultAgent !== undefined) result.default_agent = defaultAgent

    return result
  })
