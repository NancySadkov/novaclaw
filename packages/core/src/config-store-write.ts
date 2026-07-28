export * as ConfigStoreWrite from "./config-store-write"

import { Effect, Option, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogSeed } from "./catalog-seed"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { ConfigCommand } from "./config/command"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { Database } from "./database/database"
import { MergePatch } from "./merge-patch"
import { Offline } from "./offline"
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
// ⚠️ That claim was FALSE for `models` until v0.2.0-prep B7: the models-primary flat map
// (`Config.Info.models`, notes/models-primary-plan.md P1) decoded cleanly, routed nowhere and
// still answered 200 — a write that vanished while reporting success. It now expands through
// `CatalogSeed.expandFlatModels`, the SAME flat→nested transform the jsonc seed applies, so a
// PATCH and an import of one document land identically. **A new `Config.Info` key must be
// routed here (or joined SETTINGS_KEYS) in its own commit — an unrouted key is a silent
// data-loss bug, not a no-op.** The read side answers in the STORED nested `providers` shape;
// that is a normalization of a durable write, not a dropped one.
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
 * The routing itself. Kept separate from `apply` only so the transaction boundary is one
 * readable line; it must NEVER be called directly — un-transacted, a failure part-way through
 * leaves the stores in a half-written state (see `apply`).
 */
const applyToStores = (patch: Config.Info) =>
  Effect.gen(function* () {
    const consumed = new Set<string>()
    const plain = encodeInfo(patch)

    // Models-primary (notes/models-primary-plan.md P1/P2): `models` is the FLAT authoring shape —
    // one entry per model carrying its OWN endpoint `url`, whose host becomes the internal provider
    // group. The catalog stores the nested shape, so the write router expands exactly the way the
    // jsonc seed does; running the transform over `{models, model}` alone keeps the already-decoded
    // `patch.providers` on its own typed path below. `expandFlatModels` also rewrites a bare
    // default-model id that names a flat model into `providerID/modelID` — without that the stored
    // default would address a provider that does not exist.
    const expanded =
      patch.models === undefined
        ? undefined
        : (CatalogSeed.expandFlatModels({ models: plain.models, model: plain.model }) as {
            providers?: Record<string, unknown>
            model?: string
          })

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
    if (expanded !== undefined) {
      // Read AFTER the `providers` block above so a patch carrying both shapes folds in order
      // (hand-authored provider first, the flat model on top) instead of clobbering.
      const layers = yield* catalog.providers()
      for (const [id, fragment] of Object.entries(expanded.providers ?? {})) {
        const decoded = providerCodec.decode(fragment)
        // Unreachable by construction — `ModelEntry` is `Model` plus `url`, and `url` is what the
        // expansion consumes. Die rather than skip: dropping one model silently is the exact defect
        // this key had, and a rolled-back 500 is an honest fault where a partial 200 is not.
        if (Option.isNone(decoded))
          return yield* Effect.die(new Error(`config: models entry for provider "${id}" failed to decode`))
        yield* catalog.setLayers(
          ProviderV2.ID.make(id),
          collapseLayers(layers[id] ?? [], decoded.value, providerCodec.encode, providerCodec.decode),
        )
      }
      consumed.add("models")
    }
    if (patch.model !== undefined) {
      yield* catalog.setDefault(expanded?.model ?? patch.model)
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

/**
 * Route one `updateConfig` patch into the SQLite stores, ALL-OR-NOTHING. Returns the set of
 * top-level keys consumed.
 *
 * v0.2.0 ruling 2 — *a failed mutation never reports success*. This used to issue seven
 * independent writes (settings · catalog · agents · commands · references · skills · plugins),
 * so a failure at step 5 left steps 1-4 committed and the HTTP handler still answered 200. The
 * two list stores were worse: they are wipe-then-reinsert, so a failure landing between the
 * delete loop and the insert loop left the skills or plugins store EMPTY.
 *
 * The whole route now runs inside ONE `db.transaction`, and every store participates WITHOUT
 * threading a `tx` handle. That works because of two facts worth stating, since neither is
 * visible at this call site:
 *  - all seven stores close over the same `Database.Service` drizzle handle, and the driver
 *    behind it is a SINGLE native connection guarded by `Semaphore.make(1)`
 *    (`database/sqlite.bun.ts`), so there is no second connection to escape the transaction on;
 *  - `SqlClient` resolves each statement's connection from `transactionService` in the FIBER
 *    CONTEXT, which `db.transaction` installs for the duration of its body — so a plain
 *    `db.insert(...)` issued from inside a store lands on the transaction's connection.
 *
 * ⚠️ Two constraints follow. (1) Every store call must stay on the CALLING fiber: a forked fiber
 * does not inherit `transactionService`, so its statements would fall back to the semaphore the
 * transaction is holding and block. (2) Individual `.run()`s stay un-`orDie`'d inside the body;
 * `orDie` sits on the transaction as a whole (the `credential.ts` / `database/migration.ts`
 * convention). A defect from a store's own `Effect.orDie` still rolls back — the transaction
 * finalizer keys on `Exit.isSuccess`, which a die fails.
 *
 * v0.2.0-prep A3 — the airgap must APPLY, not wait for a restart. The offline policy is a
 * process-wide snapshot of exactly two things this function writes (`runtime_setting.offline` and
 * every `catalog_provider` host), and it used to be taken once, when `Offline.layer` was built:
 * flipping airgap ON in Settings blocked nothing until the next boot, while `/shell/offline`
 * re-read the same stores per request and reported 9/9 layers active — a guard that was off while
 * the status surface said it was on (ruling 3). So the re-read lives HERE, for two reasons:
 *   · AFTER the transaction commits — `Offline.reload` reads through a separate read-only
 *     connection, which must not see a half-written or uncommitted store;
 *   · at the ONE place every config write lands, rather than at each HTTP call site. The two
 *     handlers are not the only writers (the v0.2.0 `configure` tool is coming, and the handlers'
 *     layer context does not even carry `Offline.Service`), and an invariant duplicated across
 *     call sites is one a new caller can forget — ruling 2 wants it mechanical, not remembered.
 * `Offline.reload` is a no-op with no I/O in a process that never built the layer (the CLI, most
 * tests), so this costs nothing where no guard exists.
 */
export const apply = (patch: Config.Info) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const consumed = yield* db.transaction(() => applyToStores(patch)).pipe(Effect.orDie)
    if (consumed.has("offline") || consumed.has("providers") || consumed.has("models")) {
      const before = Offline.currentPolicy()
      const policy = yield* Effect.sync(() => Offline.reload())
      // Log the CHANGE, not the re-read: engaging or releasing an airgap is an operator-visible
      // event, while "saved a provider, airgap still off" is chatter that would bury it.
      if (policyKey(before) !== policyKey(policy))
        yield* Effect.logInfo("offline policy changed by a config write", {
          enabled: policy.enabled,
          allowedHosts: [...policy.allowedHosts],
        })
    }
    return consumed
  })

const policyKey = (policy: Offline.Policy) => `${policy.enabled}:${[...policy.allowedHosts].sort().join(",")}`

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
