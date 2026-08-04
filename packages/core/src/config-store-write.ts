export * as ConfigStoreWrite from "./config-store-write"

import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Log } from "@novaclaw/schema/log"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogSeed } from "./catalog-seed"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { ConfigCommand } from "./config/command"
import type { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { Database } from "./database/database"
import { Watcher } from "./filesystem/watcher"
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
// jsonc fallback anymore — and a key that routes nowhere is now REFUSED BY NAME rather than
// ignored (`NOT_ROUTED_KEYS` + `unroutedKeys` below).
//
// ⚠️ "Every key routes" was FALSE for `models` until v0.2.0-prep B7: the models-primary flat map
// (`Config.Info.models`, notes/models-primary-plan.md P1) decoded cleanly, routed nowhere and
// still answered 200 — a write that vanished while reporting success. It now expands through
// `CatalogSeed.expandFlatModels`, the SAME flat→nested transform the jsonc seed applies, so a
// PATCH and an import of one document land identically. The read side answers in the STORED
// nested `providers` shape; that is a normalization of a durable write, not a dropped one.
//
// That fix was per-key; the guard below is the class-level version of it, because "a new
// `Config.Info` key must be routed here" is a claim about a file other than the one it is written
// in — the defect class todo.md ruling 1 exists for. A field added to `config.ts` without a router
// arm compiles green, typechecks green, and ships a write that vanishes.
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
 * ─── the not-routed ledger ──────────────────────────────────────────────────────────────────────
 *
 * The `Config.Info` keys `applyToStores` deliberately does NOT write to a store, each with the
 * reason it is exempt. Every other key must be consumed by a router arm; a patch carrying a key in
 * neither set faults the whole write (see `unroutedKeys`).
 *
 * ⚠️ Adding an entry is a decision with a cost, not a formality: it declares that a value a user or
 * an agent can PATCH is accepted and then thrown away, which is the shape ruling 2 outlaws — so the
 * reason has to survive being read. `packages/core/test/config-routing-ledger.test.ts` ratchets it
 * in BOTH directions: a new `Config.Info` field that routes nowhere fails until it is routed or
 * listed, and a listed key that stops existing (or starts routing) fails with "drop the entry", so
 * the list can only shrink.
 */
export const NOT_ROUTED_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "$schema",
    "The JSON-schema pointer an editor uses to complete a hand-authored novaclaw.jsonc. It describes " +
      "the FILE, not the instance — no runtime reader consults it — and it is on `Config.Info` only " +
      "so authoring a file with it does not fail the decode. Excused rather than refused because " +
      "Settings → Export WRITES one into every exported document (config-io.tsx drops the stored " +
      "keys and stamps its own), and Import PATCHes that document straight back: refusing it would " +
      "break the product's own export→import round trip. There is nothing to store — the next " +
      "export stamps it again.",
  ],
])

/**
 * The top-level keys of `patch` that no router arm consumed and that the ledger does not excuse —
 * i.e. the keys this write would have silently dropped.
 *
 * Reads the keys off the PATCH INSTANCE rather than off `encodeInfo(patch)`: `Schema.encodeSync`
 * erases anything `Config.Info` does not declare, so a caller that hands us a hand-built object
 * would have its stray key removed before the check could name it. On the wire path the two sets
 * are identical — see the ⚠️ below.
 *
 * ⚠️ What this does NOT cover, and where that is handled now: an entirely UNKNOWN top-level key
 * never reaches here — the payload decodes with Effect Schema's default `onExcessProperty:
 * "ignore"`, so it is gone before `apply` runs. That was a live ruling-2 violation (a typo answered
 * 200 with the key silently dropped) and it is **CLOSED as of 2026-07-29** by
 * `rejectUnknownConfigKeys` in `httpapi/groups/config.ts`, which 400s at both PATCH routes and names
 * every offending key.
 *
 * **The two guards are deliberately different and neither can substitute for the other.** There =
 * a key `Config.Info` never declared, i.e. caller input, so a 400. Here = a key `Config.Info` DOES
 * declare and no router arm consumes, i.e. a programming defect that shipped, so a die inside the
 * transaction. A 400 for the second would blame the caller for our bug; a die for the first would
 * turn a typo into a 500.
 */
export const unroutedKeys = (patch: Config.Info, consumed: ReadonlySet<string>): string[] => {
  const values = patch as unknown as Record<string, unknown>
  return Object.keys(values).filter(
    (key) => values[key] !== undefined && !consumed.has(key) && !NOT_ROUTED_KEYS.has(key),
  )
}

/**
 * ─── the routing table ──────────────────────────────────────────────────────────────────────────
 *
 * Six of the ten router arms were the same eight lines with four nouns substituted, which is the
 * same copy-paste that `config-store-factory.ts` removed from the stores themselves. They are rows
 * now. What is NOT a row, and deliberately so:
 *  · `settings` — a loop already, over `SETTINGS_KEYS`, with its own deep-merge semantics;
 *  · `models` — the models-primary flat→nested expansion, which must run AFTER `providers` and
 *    dies rather than skipping on a decode failure;
 *  · `model` / `default_agent` — one whole-value write each into a `*_setting` table, and `model`
 *    additionally depends on the expansion above.
 * Forcing those three shapes into the table would mean a row with an escape hatch per column, i.e.
 * the table describing nothing. Six rows and three named exceptions is the honest split.
 *
 * ⚠️ ORDER IS PART OF THE CONTRACT, twice over. `providers` must precede `models` so a patch
 * carrying both folds hand-authored-provider-first (see the `expanded` block). And `plugins` must
 * stay LAST — `config-store-write.test.ts`'s rollback test fails it precisely because everything
 * else has already written by then.
 */

/** The store operations one layered arm needs, resolved from context when the arm actually fires. */
interface LayeredWriter<Item> {
  readonly read: () => Effect.Effect<Record<string, Item[]>>
  readonly write: (name: string, layers: Item[]) => Effect.Effect<void>
}

/**
 * One layered-entity arm. `Item` is erased at the return type so the four rows share an array,
 * and this function is where each row's types are actually checked.
 *
 * ⚠️ Each call site ANNOTATES its `write` lambda's `layers` parameter, and that is load-bearing rather
 * than decorative: the codecs arrive by spread (`...providerCodec`) *after* `store` in the object
 * literal, so when TypeScript checks the store Effect it has nothing to infer `Item` from yet and
 * falls back to `unknown` — which then fails against the real `setLayers` signature. The annotation
 * is the anchor. Reordering the literal would also work and is more fragile, because a later editor
 * moving a line back would silently re-break it.
 */
const layeredArm = <Item, R>(spec: {
  readonly key: keyof Config.Info & string
  readonly fragments: (patch: Config.Info) => { readonly [name: string]: Item } | undefined
  readonly store: Effect.Effect<LayeredWriter<Item>, never, R>
  readonly encode: (layer: Item) => unknown
  readonly decode: (value: unknown) => Option.Option<Item>
}) => ({
  key: spec.key,
  route: (patch: Config.Info): Effect.Effect<boolean, never, R> =>
    Effect.gen(function* () {
      const fragments = spec.fragments(patch)
      if (fragments === undefined) return false
      const store = yield* spec.store
      const layers = yield* store.read()
      for (const [name, fragment] of Object.entries(fragments)) {
        yield* store.write(name, collapseLayers(layers[name] ?? [], fragment, spec.encode, spec.decode))
      }
      return true
    }),
})

/** The store operations one list arm needs. `keys()` yields exactly what `remove()` accepts. */
interface ListWriter<Entry> {
  readonly keys: () => Effect.Effect<string[]>
  readonly put: (entry: Entry) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

/**
 * One list-store arm: the config value is an array (replace-wholesale contract), so the stored
 * content is wiped and reinserted. ⚠️ That is only safe because `apply` runs the whole route inside
 * ONE transaction — un-transacted, a failure landing between the two loops leaves the store EMPTY,
 * which is the ruling-2 defect the transaction was added for.
 */
const listArm = <Entry, Item, R>(spec: {
  readonly key: keyof Config.Info & string
  readonly items: (patch: Config.Info) => readonly Item[] | undefined
  readonly store: Effect.Effect<ListWriter<Entry>, never, R>
  readonly normalize: (item: Item) => Entry
}) => ({
  key: spec.key,
  route: (patch: Config.Info): Effect.Effect<boolean, never, R> =>
    Effect.gen(function* () {
      const items = spec.items(patch)
      if (items === undefined) return false
      const store = yield* spec.store
      for (const key of yield* store.keys()) yield* store.remove(key)
      for (const item of items) yield* store.put(spec.normalize(item))
      return true
    }),
})

const LAYERED_ARMS = [
  layeredArm({
    key: "providers",
    fragments: (patch) => patch.providers,
    store: Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      return {
        read: () => catalog.providers(),
        write: (id, layers: ConfigProvider.Info[]) => catalog.setLayers(ProviderV2.ID.make(id), layers),
      }
    }),
    ...providerCodec,
  }),
  layeredArm({
    key: "agents",
    fragments: (patch) => patch.agents,
    store: Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      return {
        read: () => agents.agents(),
        write: (name, layers: ConfigAgent.Info[]) => agents.setLayers(name, layers),
      }
    }),
    ...agentCodec,
  }),
  layeredArm({
    key: "commands",
    fragments: (patch) => patch.commands,
    store: Effect.gen(function* () {
      const commands = yield* CommandConfigStore.Service
      return {
        read: () => commands.commands(),
        write: (name, layers: ConfigCommand.Info[]) => commands.setLayers(name, layers),
      }
    }),
    ...commandCodec,
  }),
  layeredArm({
    key: "references",
    fragments: (patch) => patch.references,
    store: Effect.gen(function* () {
      const references = yield* ReferenceConfigStore.Service
      return {
        read: () => references.references(),
        write: (name, layers: ConfigReference.Entry[]) => references.setLayers(name, layers),
      }
    }),
    ...referenceCodec,
  }),
]

const LIST_ARMS = [
  listArm({
    key: "skills",
    items: (patch) => patch.skills,
    // UI/import writes are expected to carry absolute paths or URLs (there is no declaring file to
    // resolve a relative entry against here), so the entry is stored as given.
    normalize: (item: string) => item,
    store: Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      return {
        keys: () => skills.sources(),
        put: (source: string) => skills.addSource(source),
        remove: (source) => skills.removeSource(source),
      }
    }),
  }),
  listArm({
    key: "plugins",
    items: (patch) => patch.plugins,
    normalize: (item: ConfigPlugin.Plugin) => PluginConfigSeed.normalizePluginEntry("", item),
    store: Effect.gen(function* () {
      const plugins = yield* PluginConfigStore.Service
      return {
        keys: () => plugins.plugins().pipe(Effect.map((entries) => entries.map((entry) => entry.package))),
        put: (entry: PluginConfigStore.PluginConfigEntry) => plugins.setPlugin(entry),
        remove: (pkg) => plugins.removePlugin(pkg),
      }
    }),
  }),
]

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
    const agents = yield* AgentConfigStore.Service

    // The four layered arms, `providers` FIRST — the `models` expansion below re-reads the catalog
    // and must fold on top of a hand-authored provider from the same patch, never under it.
    for (const arm of LAYERED_ARMS) if (yield* arm.route(patch)) consumed.add(arm.key)

    if (expanded !== undefined) {
      // Read AFTER the `providers` arm above so a patch carrying both shapes folds in order
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

    // The two singleton default refs. One whole-value write each into a `*_setting` table, and
    // `model` additionally reads the expansion above — neither is a layered fold.
    if (patch.model !== undefined) {
      yield* catalog.setDefault(expanded?.model ?? patch.model)
      consumed.add("model")
    }
    if (patch.default_agent !== undefined) {
      yield* agents.setDefault(patch.default_agent)
      consumed.add("default_agent")
    }

    // The list arms, `plugins` LAST — the rollback test in config-store-write.test.ts fails the
    // plugin write precisely because every other store has committed by the time it runs.
    for (const arm of LIST_ARMS) if (yield* arm.route(patch)) consumed.add(arm.key)

    // Ruling 2, second clause — *a failed mutation never reports success.* Everything above is a
    // per-key arm — three hand-written `if`s and six table rows — so the failure mode of forgetting
    // one is not a compile error and not a test failure: it is a 200 for a write that went nowhere.
    // This is the ONE place that can tell the difference, because `consumed` is the router's own
    // record of what it did rather than a second list that can drift from it. (The table did not
    // make that impossible either: a row whose `key` disagrees with its `fragments` reader routes
    // the wrong thing just as quietly, which is why `config-routing-ledger.test.ts` reads the rows
    // out of this source AND ties them to a live `apply`.)
    //
    // It runs INSIDE the transaction on purpose, and dies rather than failing:
    //  · inside, so the earlier stores roll back — a partial apply that reports failure is its own
    //    ruling-2 problem, and `apply` is documented as all-or-nothing;
    //  · `Effect.die`, because this can only fire on a `Config.Info` field whose router arm was
    //    never written. That is a programming defect, not user input, so it wants the same
    //    vocabulary as the `models` decode failure above — "a rolled-back 500 is an honest fault
    //    where a partial 200 is not" — and needs no new wire error (which would need an
    //    OpenAPI/SDK regen for a case no user can reach).
    const unrouted = unroutedKeys(patch, consumed)
    if (unrouted.length > 0)
      return yield* Effect.die(
        new Error(
          `config: nothing routes ${unrouted.map((key) => `"${key}"`).join(", ")} — the whole write was ` +
            `rolled back rather than answer 200 for a key that vanished. Give the key a router arm in ` +
            `config-store-write.ts (or join it to SettingsConfigSeed.SETTINGS_KEYS), or add it to ` +
            `NOT_ROUTED_KEYS with the reason it is accepted and discarded.`,
        ),
      )

    return consumed
  })

/**
 * ─── the runtime-domain reload registry ─────────────────────────────────────────────────────────
 *
 * v0.2.0-prep B7 / ruling 3 — *a settings change is not a reboot*, for the domains a user edits in
 * Settings that are MATERIALISED rather than read through: agents, commands, references, skills —
 * and the CATALOG (providers/models, which carries `integration` with it).
 *
 * Each of those is built once, at location boot, by a `ctx.<domain>.transform(...)` callback that
 * `config/plugin/{agent,command,reference,skill,provider}.ts` registers on the domain's `State` — and
 * `state.ts` re-runs a transform only on an explicit `.reload()`. Until this registry existed,
 * nothing on the config-write path called it: the ONLY thing that made an edited agent take effect
 * was the whole layer graph being torn down (`markInstanceForDisposal`), i.e. terminals, pending
 * asks and MCP children destroyed because someone renamed an agent. B7 exists to delete that
 * teardown, so this has to land first or dropping it turns "edit an agent" into a silent no-op.
 *
 * ⚠️ Why a module-level registry and not a service lookup, exactly as `filesystem/watcher.ts`
 * argues for itself: the caller that must fire it is `apply` — the one place a config write commits
 * — and `apply`'s context carries the config STORES, never `AgentV2.Service`/`CommandV2.Service`/
 * `Reference.Service`/`SkillV2.Service`/`Catalog.Service`. Those are per-LOCATION, and a config write
 * is instance-wide, so it is a SET per domain: one process holds one of each per open location and
 * all of them re-materialise.
 *
 * ⚠️ The dependency direction is the opposite of the watcher's, on purpose. `Offline` and `Watcher`
 * are leaf modules, so `apply` can import them; `config/plugin/*.ts` sit inside the plugin graph
 * (each imports `plugin/internal.ts`, which pulls Catalog, Integration, ModelsDev, Npm and the HTTP
 * client), and importing them from here would drag all of that into every process that can write
 * config — the CLI included. So the four plugins register INTO this module instead. Nothing in this
 * file's own import graph reaches `plugin/internal.ts`, so that direction stays acyclic.
 *
 * ⚠️ B7 tier-3 added three registrants from `packages/novaclaw` (`config/config.ts`,
 * `format/index.ts`, `mcp/index.ts`) and the acyclic argument above is UNCHANGED by them, for a
 * stronger reason than it holds for the plugins: `packages/core` cannot import `packages/novaclaw` at
 * all — the dependency runs one way — so a registrant there can only ever add an edge INTO this
 * module. Nothing was added to this file's own imports.
 *
 * ⚠️ **ORDER IS PART OF THE CONTRACT here too, and `refreshDomains` honours this array's order.**
 * `instance_config` re-derives the novaclaw-side merged instance document, which `formatter` and
 * `mcp` then read to decide what changed — so it MUST come first, and putting it anywhere else in
 * this array would make both of them reconcile against the document they were already holding. The
 * five middle domains are mutually independent and their relative order carries no meaning.
 */
export const RELOAD_DOMAINS = [
  "instance_config",
  "agents",
  "commands",
  "references",
  "skills",
  "catalog",
  "formatter",
  "mcp",
] as const
export type ReloadDomain = (typeof RELOAD_DOMAINS)[number]

/**
 * ─── keys a config write CANNOT make live, each with the reason ──────────────────────────────────
 *
 * v0.2.0 ruling 2 — *a fault is never described falsely*, and ruling 3's *a settings change is not a
 * reboot* is a goal rather than a licence to pretend. A key here is accepted, stored durably, served
 * back by `GET /config` — and NOT in force in this process until it restarts. That is a real, partial
 * failure, so `apply` SAYS SO by name instead of answering an unqualified 200.
 *
 * ⚠️ An entry is a confession, not a category. It must name the mechanism that makes the key
 * unreachable, and `config-instance-reload-ledger.test.ts` ratchets the list in both directions: an
 * entry that stops being a `Config.Info` key fails, and an entry that acquires a reload trigger fails
 * with "drop it" — so the list can only shrink.
 */
export const RESTART_REQUIRED_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "plugins",
    "An external plugin is a JavaScript module `config/plugin/external.ts` brings into this process " +
      "with `import()`, and ESM caches a module URL for the life of the process: a changed plugin " +
      "file cannot be re-read, and an already-registered plugin cannot be unregistered. So there is " +
      "no in-place cure — only a restart, or a redesign that runs plugins out-of-process. Ruling 5 " +
      "has already chosen the second and deleted the premise: outside code never runs in-process, " +
      "MCP is the out-of-process seam, and this loader plus this key are scheduled for removal " +
      "(todo.md → 'Ruling 5 in execution', item ②). Building a live reload for it would add " +
      "third-party code execution to the config-write path to serve a surface we are deleting.",
  ],
])

/**
 * Which `Config.Info` keys leave which domain stale — the per-key discipline `consumed.has(...)`
 * already uses for `offline`/`watcher`, because a reload is not free and an unconditional one would
 * be its own bug (a `references` reload re-fetches every remote git reference; see below).
 *
 * The cost of each, so the next person does not have to re-derive it — all of them are bounded by
 * "a few SQLite reads plus a markdown glob over the config directories", never a layer build:
 *  · `agents` — two transforms. The built-in (`plugin/agent.ts`) is pure CPU: it rebuilds ~7 agents'
 *    permission rulesets. The config one re-reads the agent store, `config.entries()` (one settings
 *    SELECT) and re-globs `{agent,agents}/**` + `{mode,modes}/*.md` under each config directory.
 *  · `commands` — same shape, one glob (`{command,commands}/**\/*.md`), smaller built-in.
 *  · `references` — one store read and a map rebuild. ⚠️ Its `finalize` also forks a
 *    `RepositoryCache.ensure({refresh:true})` per REMOTE git reference, i.e. a git fetch. Forked, so
 *    it does not block the write, and it only fires when the user edited `references` — which is
 *    when re-fetching is the thing they asked for. It must never be triggered by an unrelated key.
 *  · `skills` — one store read plus `config.entries()`. The expensive part (globbing and reading
 *    every SKILL.md) is NOT paid here: the reload only clears the summary cache and the walk is
 *    lazy, on the next `SkillV2.list()`.
 *
 *  · `catalog` — two store reads (`CatalogStore.providers()` + `getDefault()`) replayed onto a fresh
 *    draft, plus the `integration` reload it chains (a second pass over the same layers). No network:
 *    the models.dev refresh is a SEPARATE trigger (`plugin/models-dev.ts`), and credentials are read
 *    lazily at use. Measured on a booted location: the whole write + re-materialise is in the same
 *    band as `agents`.
 *
 * `permissions` is in the `agents` list and that is not scope creep: `config/plugin/agent.ts` folds
 * the global ruleset out of `config.entries()` into EVERY agent's `permissions` at materialisation
 * time, so an edited global rule is frozen into agent state exactly the way an edited agent is.
 * Leaving it out would keep a ruling-3 hole open in the very domain this closes.
 *
 * ⚠️ `catalog` was NOT in this table when the registry landed, and it is the domain B7's final step
 * could least afford to miss: `config/plugin/provider.ts` materialises every provider and model from
 * `CatalogStore` at location boot, so dropping `markInstanceForDisposal` without it would have made
 * AGENTS.md's own self-healing example stop working verbatim — *"a lay user whose provider moved its
 * servers just asks any still-working model to fix it (one PATCH updates `providers.<id>.api.url`),
 * no restart"*. Measured 2026-07-31 before this entry existed: the write commits, `/config` reads it
 * back, and the location's `Catalog` still served nothing at all
 * (`packages/core/test/config-catalog-reload.test.ts`).
 *
 * ⚠️ And `disabled_providers`/`enabled_providers` are deliberately NOT triggers. They are settings
 * keys that no core reader consults — grepped 2026-07-31: `config.ts` declares them, the settings
 * seed stores them, and nothing else in `packages/core/src` reads either one. Adding them would be a
 * reload fired on a key that changes nothing, i.e. the per-key discipline abandoned for a guess.
 *
 * ─── the three B7 tier-3 domains, which live in `packages/novaclaw` ──────────────────────────────
 *
 *  · `instance_config` — the novaclaw-side MERGED INSTANCE DOCUMENT (`novaclaw/src/config/config.ts`,
 *    an `InstanceState` keyed by instance directory). It is what every novaclaw service means by
 *    "the config", and until B7 tier-3 nothing refreshed it: `Config.invalidate()` clears only the
 *    process-global store overlay, so the per-instance document stayed at its first-read value for
 *    the life of the process and the ONLY thing that replaced it was the instance being destroyed.
 *    The reload re-runs that merge. Cost is the honest reason its trigger list is SHORT: the merge
 *    re-reads the stores, re-globs `{agent,agents}`/`{command,commands}`/`{plugin,plugins}` under
 *    each config directory, re-reads the managed-MDM directory, and re-fetches any `.well-known`
 *    remote config the user has authenticated against — bounded, and strictly cheaper than the
 *    location boot the teardown used to pay, but not free enough to fire on every key.
 *
 *    ⚠️ **`skills`, `agents`, `permissions` and `references` are deliberately NOT triggers for it,
 *    and that is a scoping decision with a name, not an oversight.** Those keys DO reach the merged
 *    document, and `novaclaw/src/{skill,agent}` read them — but each of those services caches its own
 *    DERIVED value in its own `InstanceState` (`Skill.discovery`, `Skill.state`, `Agent.state`), so
 *    refreshing the document underneath them would change nothing any caller can observe. Adding
 *    them would buy a glob per config write and a claim that the domain is handled. The core-side
 *    `agents`/`skills`/`references` domains above ARE handled; the novaclaw-side duplicates are a
 *    separate, pre-existing gap (they serve the CLI and two HTTP handlers, not the V2 session
 *    runner), filed rather than half-fixed.
 *
 *  · `formatter` — `novaclaw/src/format/index.ts` builds its formatter table once per instance from
 *    `formatter`, so the reload re-derives it. Cost: rebuilding a record of ~10 formatter descriptors
 *    plus dropping the memoized "is this binary on PATH" probes, which are re-taken lazily on the
 *    next format.
 *
 *  · `mcp` — `novaclaw/src/mcp/index.ts` RECONCILES: it connects servers the write added, closes the
 *    ones it removed, and reconnects the ones whose entry changed. ⚠️ It is emphatically not a
 *    rebuild. The state's finalizer tree-kills every connected server's child processes, so
 *    re-materialising this domain would destroy MCP servers the user never touched — the precise
 *    behaviour tier-2 removed, at a smaller size. Cost for an unrelated `mcp` write (e.g. a timeout
 *    change on one server): one comparison per configured server, no I/O.
 */
const RELOAD_TRIGGERS: Record<ReloadDomain, readonly (keyof Config.Info)[]> = {
  instance_config: ["formatter", "snapshots", "mcp"],
  agents: ["agents", "default_agent", "permissions"],
  commands: ["commands"],
  references: ["references"],
  skills: ["skills"],
  catalog: ["providers", "models", "model"],
  formatter: ["formatter"],
  mcp: ["mcp"],
}

interface ReloadRegistration {
  readonly reload: () => Effect.Effect<void>
}

const registered: Record<ReloadDomain, Set<ReloadRegistration>> = {
  instance_config: new Set(),
  agents: new Set(),
  commands: new Set(),
  references: new Set(),
  skills: new Set(),
  catalog: new Set(),
  formatter: new Set(),
  mcp: new Set(),
}

const dispatched: Record<ReloadDomain, number> = {
  instance_config: 0,
  agents: 0,
  commands: 0,
  references: 0,
  skills: 0,
  catalog: 0,
  formatter: 0,
  mcp: 0,
}

/**
 * Register one location's re-materialise for `domain`, for the life of the calling Scope.
 *
 * Called from the config plugin that owns the domain's transform, so the registration lives and
 * dies with that plugin's scope — a plugin reload or a location close deregisters it, and a stale
 * closure never fans out on a later write. The registration token is an object rather than the
 * function itself so two locations that somehow share a `reload` reference still count as two.
 */
export const registerReload = (domain: ReloadDomain, reload: () => Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const registration: ReloadRegistration = { reload }
      registered[domain].add(registration)
      return registration
    }),
    (registration) =>
      Effect.sync(() => {
        registered[domain].delete(registration)
      }),
  ).pipe(Effect.asVoid)

/** Live registrations for `domain` (one per open location). Exported so "the wiring exists" can be
 *  asserted rather than reasoned about — the job `Watcher.registeredWatchers()` does for watchers. */
export function registeredReloads(domain: ReloadDomain): number {
  return registered[domain].size
}

/** Reloads this module has DISPATCHED for `domain` (monotonic, counts attempts not successes).
 *  Pairs with the above to tell "refreshed" from "never asked", and is what makes "an unrelated
 *  config key costs this domain nothing" a measurement instead of a claim. */
export function reloadsDispatched(domain: ReloadDomain): number {
  return dispatched[domain]
}

/** The domains a write consuming `consumed` has left stale, in `RELOAD_DOMAINS` order. Exported so
 *  the ordering contract can be asserted directly rather than inferred from a live `apply`. */
export const staleDomains = (consumed: ReadonlySet<string>): ReloadDomain[] =>
  RELOAD_DOMAINS.filter((domain) => RELOAD_TRIGGERS[domain].some((key) => consumed.has(key)))

/** The keys of `consumed` this process cannot make live — see {@link RESTART_REQUIRED_KEYS}. */
export const restartRequired = (consumed: ReadonlySet<string>): string[] =>
  [...RESTART_REQUIRED_KEYS.keys()].filter((key) => consumed.has(key))

/**
 * Re-materialise every registered location for each stale domain.
 *
 * Ruling 2, and the honest answer is neither of the two obvious ones. The transaction has already
 * COMMITTED when this runs, so the write is durable and cannot be rolled back — "it failed" would
 * describe the fault falsely, and a plain 200 would report success for a change that is not live.
 * So: attempt every domain (one broken domain must not cost the others their refresh), then say
 * exactly what happened — a log naming the domains and their causes, and a defect whose message is
 * *committed, not live*, so the caller does not re-send the write expecting a different outcome.
 *
 * Half-materialisation is not reachable from here, and that is a property of `state.ts` rather than
 * of this call: `materialize` builds a fresh value and only `commit`s it after every transform has
 * run, so a transform that dies leaves the PREVIOUS good state in place. A failed reload is stale,
 * never torn.
 *
 * ⚠️ **Domains run in `RELOAD_DOMAINS` order, one domain at a time; registrations WITHIN a domain
 * still run concurrently.** This used to be one flat unbounded fan-out, which was correct while every
 * domain was independent and stopped being correct when `instance_config` landed: `formatter` and
 * `mcp` both reconcile against the document that domain re-derives, so a race would let either read
 * the value it was already holding — a reload that runs and changes nothing, which is worse than not
 * running because `reloadsDispatched` would report it as done. The cost of serialising is one extra
 * round of SQLite reads end-to-end rather than in parallel; the domains that were already here are
 * unaffected in behaviour.
 */
const refreshDomains = (domains: readonly ReloadDomain[]) =>
  Effect.gen(function* () {
    const failures: { readonly domain: ReloadDomain; readonly cause: Cause.Cause<never> }[] = []

    for (const domain of RELOAD_DOMAINS) {
      if (!domains.includes(domain)) continue
      const targets = [...registered[domain]]
      dispatched[domain] += targets.length
      yield* Effect.forEach(
        targets,
        (registration) =>
          // `Effect.exit` rather than `catchCause` because a transform failure is turned into a
          // DEFECT by `State.apply`'s `orDie` — a handler that only sees the typed error channel
          // would let it through and lose the "committed, not live" message below.
          Effect.suspend(registration.reload).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    failures.push({ domain, cause: exit.cause })
                  })
                : Effect.void,
            ),
          ),
        { discard: true, concurrency: "unbounded" },
      )
    }
    if (failures.length === 0) return

    const named = [...new Set(failures.map((failure) => failure.domain))].sort()
    yield* Log.event("config.runtime.reload.failed", {
      "config.domains": JSON.stringify(named),
      "config.causes": JSON.stringify(failures.map((failure) => Cause.pretty(failure.cause))),
    })
    return yield* Effect.die(
      new Error(
        `config: the write is COMMITTED and durable, but ${named.map((domain) => `"${domain}"`).join(", ")} ` +
          `could not be re-materialised, so the change is saved but NOT LIVE until this instance restarts. ` +
          `This is not a rejected write — re-sending it will not change the outcome; the logged cause names ` +
          `what failed.`,
      ),
    )
  })

/**
 * Route one `updateConfig` patch into the SQLite stores, ALL-OR-NOTHING. Returns the set of
 * top-level keys consumed — which is now TOTAL over the patch: every key it carried is either in
 * this set or in `NOT_ROUTED_KEYS`, or the write faulted instead of returning (see `unroutedKeys`).
 * So `consumed.size === 0` means "the patch asked for nothing storable", never "we dropped it".
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
 *
 * v0.2.0-prep B7 tier-2 — `Watcher.reload` rides the same chokepoint for the same reasons, but it
 * is a different CURE. Offline froze a value, so reading through fixes it; the watcher hands its
 * ignore list to `@parcel/watcher` when the subscription is established, so no read-through can
 * reach a live subscription — it has to re-SUBSCRIBE. Same seam, same "one place every config write
 * lands" argument, same no-op-where-no-layer-was-built property.
 *
 * v0.2.0-prep B7 tier-2 — and `refreshDomains` is the THIRD cure at the same seam, for the domains
 * that are neither a frozen value nor an OS subscription but a MATERIALISED graph: agents, commands,
 * references, skills and the catalog. Their cure is re-running the transform that built them
 * (`registerReload` above). Until this landed, an edited agent only took effect when the whole layer
 * graph was destroyed — the `markInstanceForDisposal` path B7 removes — so an agent, command,
 * reference, skill or PROVIDER edited in Settings would have silently stopped applying the moment
 * that teardown was dropped.
 *
 * v0.2.0-prep B7 tier-3 — the same seam again, now for the caches that live in `packages/novaclaw`
 * rather than in core: the per-instance merged config document (`instance_config`), the formatter
 * table (`formatter`) and the connected MCP server set (`mcp`). Those were the last things the
 * teardown was silently refreshing, and `InstanceState.invalidate` had ZERO callers tree-wide — the
 * instance being destroyed WAS their refresh. `plugins` is the one key that stays stuck, and it says
 * so by name rather than by omission (`RESTART_REQUIRED_KEYS`).
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
        yield* Log.event("config.offline.change", {
          "config.offline.enabled": policy.enabled,
          "config.offline.hosts": JSON.stringify([...policy.allowedHosts]),
        })
    }
    if (consumed.has("watcher")) yield* Watcher.reload()
    // Ruling 2 BEFORE the reloads, not after: the reloads can die ("committed, not live"), and a key
    // this process was never going to apply is a fact the operator needs either way.
    const stuck = restartRequired(consumed)
    if (stuck.length > 0)
      yield* Log.event("config.runtime.restart.required", {
        "config.keys": JSON.stringify(stuck),
        "config.reasons": JSON.stringify(stuck.map((key) => RESTART_REQUIRED_KEYS.get(key))),
      })
    yield* refreshDomains(staleDomains(consumed))
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
