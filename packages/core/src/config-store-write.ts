export * as ConfigStoreWrite from "./config-store-write"

import { Effect, Option, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { ConfigCommand } from "./config/command"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { MergePatch } from "./merge-patch"
import { PluginConfigSeed } from "./plugin-config-seed"
import { PluginConfigStore } from "./plugin-config-store"
import { ProviderV2 } from "./provider"
import { ReferenceConfigStore } from "./reference-config-store"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SettingsConfigStore } from "./settings-config-store"
import { SkillConfigStore } from "./skill-config-store"

// Config→SQLite step 7→9: the Settings-UI write router + read overlay. The app's
// `updateConfig` contract is patch-MERGE over the effective config; this module routes each
// top-level key of such a patch into its owning SQLite store — and mirrors the same keys back
// over the served view so the UI reads what it wrote. Since step 9 EVERY Config.Info key
// routes (`instructions` + `disabled/enabled_providers` joined SETTINGS_KEYS); there is no
// jsonc fallback anymore — an unrouted key (only `$schema`) is ignored.
//
// Merge semantics per store shape:
// - settings keys: one whole value per key — deep-merge the patch into the stored value
//   (objects merge, arrays replace wholesale — the documented updateConfig contract).
// - layered stores (providers/agents/commands/references): fold the stored layers AND the patch
//   fragment into ONE layer (`collapseLayers`) — the same left fold the runtime and the served view
//   already apply, so the value is unchanged while the list stays bounded.
// - list stores (skills/plugins): the config value is an array (replace-wholesale contract) —
//   the store content is replaced.

/** Deep patch-merge: objects merge recursively, arrays and primitives replace (merge-patch.ts). */
export const mergePatch = MergePatch.mergePatch

/**
 * Collapse a layered entity's stored layers PLUS the incoming patch fragment into a SINGLE layer.
 *
 * Writes used to APPEND one layer per save, unbounded — a dev instance reached 12 layers for one
 * provider, several of them successive edits of the same field. Appending did reproduce patch-merge,
 * but nothing ever compacted the history, so the stored blob grew for the lifetime of the instance.
 *
 * Folding is value-preserving, not merely close enough: `mergePatch` has no null-deletion, so it is a
 * plain recursive merge and therefore associative — folding left-to-right equals applying the layers
 * in order. It is also the IDENTICAL fold that `foldLayers` below already applies to build both the
 * served `/config` view and the jsonc export document (and importing that document yields exactly one
 * layer). So this makes the stored layers agree with what Settings shows the user, rather than letting
 * the two drift apart.
 *
 * Falls back to appending when the folded value does not decode: a merge edge case must never fail a
 * user's save, and one extra layer is the previous, harmless behaviour.
 */
function collapseLayers<A>(
  existing: readonly A[],
  fragment: A,
  encode: (layer: A) => unknown,
  decode: (value: unknown) => Option.Option<A>,
): A[] {
  if (existing.length === 0) return [fragment]
  const folded = [...existing, fragment].reduce<unknown>(
    (merged, layer) => mergePatch(merged, encode(layer)),
    undefined,
  )
  const decoded = decode(folded)
  return Option.isSome(decoded) ? [decoded.value] : [...existing, fragment]
}

const providerCodec = {
  encode: Schema.encodeSync(ConfigProvider.Info),
  decode: Schema.decodeUnknownOption(ConfigProvider.Info),
}
const agentCodec = {
  encode: Schema.encodeSync(ConfigAgent.Info),
  decode: Schema.decodeUnknownOption(ConfigAgent.Info),
}
const commandCodec = {
  encode: Schema.encodeSync(ConfigCommand.Info),
  decode: Schema.decodeUnknownOption(ConfigCommand.Info),
}
const referenceCodec = {
  encode: Schema.encodeSync(ConfigReference.Entry),
  decode: Schema.decodeUnknownOption(ConfigReference.Entry),
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
        yield* catalog.setLayers(
          ProviderV2.ID.make(id),
          collapseLayers(layers[id] ?? [], fragment, providerCodec.encode, providerCodec.decode),
        )
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
        yield* agents.setLayers(
          name,
          collapseLayers(layers[name] ?? [], fragment, agentCodec.encode, agentCodec.decode),
        )
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
        yield* commands.setLayers(
          name,
          collapseLayers(layers[name] ?? [], fragment, commandCodec.encode, commandCodec.decode),
        )
      }
      consumed.add("commands")
    }

    if (patch.references !== undefined) {
      const references = yield* ReferenceConfigStore.Service
      const layers = yield* references.references()
      for (const [name, fragment] of Object.entries(patch.references)) {
        yield* references.setLayers(
          name,
          collapseLayers(layers[name] ?? [], fragment, referenceCodec.encode, referenceCodec.decode),
        )
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

/** Fold a layered-store record into one merged config fragment per name (layers in order). */
function foldLayers<A>(layers: Record<string, A[]>, encode: (layer: A) => unknown) {
  const folded: Record<string, unknown> = {}
  for (const [name, list] of Object.entries(layers)) {
    folded[name] = list.reduce<unknown>((merged, layer) => mergePatch(merged, encode(layer)), undefined)
  }
  return folded
}

/**
 * Overlay the store-backed keys onto a file-derived config view (the /config GET responses),
 * so the Settings UI reads exactly what the router wrote — and, over an empty base, the
 * complete stores→jsonc EXPORT document (config-sqlite step 8: the Config-Export payload).
 * Layered stores fold with the same patch-merge the runtime applies layer-by-layer. Writes now
 * collapse to one layer (`collapseLayers`), so this fold is normally over a single entry; it still
 * compacts the multi-source SEEDED layers, and any entity last written before that fix.
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
      result.providers = foldLayers(providerLayers, Schema.encodeSync(ConfigProvider.Info))
    }
    const defaultModel = yield* catalog.getDefault()
    if (defaultModel !== undefined) result.model = defaultModel

    const agents = yield* AgentConfigStore.Service
    const agentLayers = yield* agents.agents()
    if (Object.keys(agentLayers).length > 0) {
      result.agents = foldLayers(agentLayers, Schema.encodeSync(ConfigAgent.Info))
    }
    const defaultAgent = yield* agents.getDefault()
    if (defaultAgent !== undefined) result.default_agent = defaultAgent

    const commands = yield* CommandConfigStore.Service
    const commandLayers = yield* commands.commands()
    if (Object.keys(commandLayers).length > 0) {
      result.commands = foldLayers(commandLayers, Schema.encodeSync(ConfigCommand.Info))
    }

    const references = yield* ReferenceConfigStore.Service
    const referenceLayers = yield* references.references()
    if (Object.keys(referenceLayers).length > 0) {
      result.references = foldLayers(referenceLayers, Schema.encodeSync(ConfigReference.Entry))
    }

    const skills = yield* SkillConfigStore.Service
    const sources = yield* skills.sources()
    if (sources.length > 0) result.skills = sources

    const plugins = yield* PluginConfigStore.Service
    const entries = yield* plugins.plugins()
    if (entries.length > 0) {
      result.plugins = entries.map((entry) => (entry.options ? entry : entry.package))
    }

    return result
  })
