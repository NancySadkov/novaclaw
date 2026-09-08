export * as ConfigStoreWrite from "./config-store-write"

import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "./agent"
import { AgentConfigStore } from "./agent-config-store"
import { AgentRemoval } from "./agent/removal"
import { AgentReassignment } from "./agent/reassignment"
import { AgentWorkspace } from "./agent/workspace"
import { CatalogSeed } from "./catalog-seed"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { ConfigCommand } from "./config/command"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { Database } from "./database/database"
import { Watcher } from "./filesystem/watcher"
import { ModelPrune } from "./catalog/model-prune"
import { MergePatch } from "./merge-patch"
import { CommunityConsent } from "./community/consent"
import { CommunityDht } from "./community/dht"
import { Offline } from "./offline"
import { ProviderV2 } from "./provider"
import { ReferenceConfigStore } from "./reference-config-store"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SettingsConfigStore } from "./settings-config-store"
import { SkillConfigStore } from "./skill-config-store"

// Config→SQLite step 7→9: the Settings-UI write router + read overlay. The app's
// `updateConfig` contract is patch-MERGE over the effective config; this module routes each
// top-level key of such a patch into its owning SQLite store — and mirrors the same keys back
// over the served view so the UI reads what it wrote. Since step 9 EVERY Config.Info key
// routes (`instructions` + `disabled_providers` joined SETTINGS_KEYS); there is no
// jsonc fallback anymore — and a key that routes nowhere is now REFUSED BY NAME rather than
// ignored (`NOT_ROUTED_KEYS` + `unroutedKeys` below).
//
// ⚠️ "Every key routes" was FALSE for `models` until v0.2.0-prep B7: the models-primary flat map
// (`Config.Info.models`) decoded cleanly, routed nowhere and
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
// - list stores (skills): the config value is an array (replace-wholesale contract) —
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
 * ⚠️ ORDER IS PART OF THE CONTRACT: `providers` must precede `models` so a patch carrying both
 * folds hand-authored-provider-first (see the `expanded` block).
 */

/** The store operations one layered arm needs, resolved from context when the arm actually fires.
 *
 *  ⚠️ `removeEntity` is here rather than in a second table because MERGE and REMOVE are two verbs
 *  over ONE routing table (item 4.3). A parallel remove-table would be four more rows that have to
 *  agree with these four about which store owns which key — and the failure mode of a disagreement
 *  is a delete that lands in the wrong store, silently. */
interface LayeredWriter<Item> {
  readonly read: () => Effect.Effect<Record<string, Item[]>>
  readonly write: (name: string, layers: Item[]) => Effect.Effect<void>
  readonly removeEntity: (name: string) => Effect.Effect<void>
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
  /**
   * The REMOVE verb for this key. `rest` is the path with the top-level key already consumed:
   * `[name]` drops the whole entity, `[name, ...inner]` prunes one field out of it.
   *
   * ⚠️ **`inner` is stripped from EVERY layer, not just the top one, and that is the defect this
   * whole design exists to avoid.** A layered entity's served value is a positional left fold, so
   * removing a model from the newest layer alone lets the seeded layer underneath resurrect it on
   * the next read — a delete that reports success and then undoes itself. `ModelPrune.stripModel`
   * already learned this for models; the fold is the same for agents, commands and references.
   */
  remove: (rest: MergePatch.Path): Effect.Effect<boolean, never, R> =>
    Effect.gen(function* () {
      const store = yield* spec.store
      const layers = yield* store.read()
      const [name, ...inner] = rest as [string, ...string[]]
      const existing = layers[name]
      if (existing === undefined || existing.length === 0) return false
      if (inner.length === 0) {
        yield* store.removeEntity(name)
        return true
      }
      let found = false
      const next = existing.map((layer) => {
        const pruned = MergePatch.removeAt(layer, inner)
        if (pruned === undefined) return layer
        found = true
        return pruned.value as Item
      })
      if (!found) return false
      yield* store.write(name, next)
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
        removeEntity: (id) => catalog.removeProvider(ProviderV2.ID.make(id)),
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
        // ⚠️ This drops the ROW ONLY. Pruning a `default_agent` that pointed at it is NOT in the
        // store — it lives in `packages/server/src/handlers/agent.ts`, and `provider.remove` /
        // `provider.removeModel` each carry their own copy of the same rule. `pruneDanglingDefaults`
        // below is this module's copy, and the duplication is filed rather than hidden.
        // 🔴 …AND RETIRE WHAT THE ROW LEFT BEHIND. Dropping the row un-hires the colleague; its
        // private memories, its spend and its chats are keyed on the id and survive it. Officer names
        // are drawn from a FIXED POOL, so the id returns and the next colleague drawn on it would
        // open holding a stranger's memories — measured 2026-08-22 through this exact door.
        //
        // Announced rather than done here: this module has no memory client (see `agent/removal.ts`).
        // 🔴 A PROTECTED agent's row is removed WITHOUT announcing a retirement, and the difference
        // is the whole point of allowing the removal at all. Deleting Nova's row does not delete
        // Nova — it RESTORES the shipped brief (see the `remove` verb's own note). But the announce
        // is what `AgentRemoval.node` turns into `AgentRetire.everything`: chats archived, the
        // private cabinet set aside, usage cleared. So the documented repair for a stale override
        // quietly retired the governing agent, and the roster kept a Nova whose history had been
        // filed away underneath it.
        removeEntity: (name) =>
          agents
            .removeAgent(name)
            .pipe(Effect.andThen(AgentV2.isProtected(name) ? Effect.void : AgentRemoval.announce(name))),
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
        removeEntity: (name) => commands.removeCommand(name),
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
        removeEntity: (name) => references.removeReference(name),
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
]

/**
 * The routing itself. Kept separate from `apply` only so the transaction boundary is one
 * readable line; it must NEVER be called directly — un-transacted, a failure part-way through
 * leaves the stores in a half-written state (see `apply`).
 */
const applyToStores = (patch: Config.Info) =>
  Effect.gen(function* () {
    // 🔴 PRE-FLIGHT, before a single store is touched: a fragment naming the governing agent is
    // refused rather than written-and-ignored. One place, no per-arm plumbing, and all-or-nothing —
    // the rest of the patch is NOT applied, matching the remove verb's rule that a refused request
    // never half-lands.
    const protectedAgents = Object.keys(patch.agents ?? {}).filter((name) => AgentV2.isProtected(name))
    if (protectedAgents.length > 0)
      return yield* Effect.fail(
        new ConfigWriteRefused({
          keys: protectedAgents,
          message:
            `config: NOTHING was written — ${protectedAgents.map((name) => `"${name}"`).join(", ")} ` +
            `is this instance's governing agent and its profile is fixed in code. Every other agent ` +
            `on the roster can be edited, and you can create your own.`,
        }),
      )
    const consumed = new Set<string>()
    const plain = encodeInfo(patch)

    // Models-primary: `models` is the FLAT authoring shape —
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

    // The list arms. `skills` is the last store to write, which is what the rollback test in
    // config-store-write.test.ts fails on purpose — every other store has committed by then.
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
 *
 * ⭐ **It is EMPTY, and that is the shipped state, not an oversight.** Its one entry was `plugins`,
 * whose confession read "no in-place cure — only a restart, or a redesign that runs plugins
 * out-of-process". Ruling 5 / step 17 took the second option all the way: the key and the `npm.add`
 * arm are deleted, so there is no longer a config write this instance cannot make live. Keep the map
 * and its ledger test — the next key that cannot go live must confess here rather than answer an
 * unqualified 200.
 */
export const RESTART_REQUIRED_KEYS: ReadonlyMap<string, string> = new Map([])

/**
 * Which `Config.Info` keys leave which domain stale — the per-key discipline `consumed.has(...)`
 * already uses for `offline`/`watcher`, because a reload is not free and an unconditional one would
 * be its own bug (a `references` reload re-fetches every remote git reference; see below).
 *
 * The cost of each, so the next person does not have to re-derive it — all of them are bounded by
 * "a few SQLite reads plus any domain-specific resource scan", never a layer build:
 *  · `agents` — two transforms. The built-in (`plugin/agent.ts`) is pure CPU: it rebuilds ~7 agents'
 *    permission rulesets. The config one re-reads the agent store and `config.entries()` (one
 *    settings SELECT). It never reads project agent/mode markdown.
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
 * ⚠️ And `disabled_providers` is deliberately NOT a trigger — for a reason about
 * its READER, not about its reach. Re-checked tree-wide 2026-09-01: `cli/cmd/providers.ts`
 * reads it and `settings-v2/dialog-new-model.tsx:403` writes `disabled_providers`, so they are not
 * inert keys. But the only reader is a CLI command that resolves config once per process and exits,
 * so **no live location holds a value derived from them for an invalidation to reach.** A trigger here
 * would fire a reload that changes nothing observable, i.e. the per-key discipline abandoned for a
 * guess. ⚠️ Add one the day a long-lived service reads either key — and note that the earlier version
 * of this note claimed *no reader exists*, which was true only because its grep was scoped to
 * `packages/core/src`. Scope a negative to the tree or do not write it.
 *
 * ─── the three B7 tier-3 domains, which live in `packages/novaclaw` ──────────────────────────────
 *
 *  · `instance_config` — the novaclaw-side MERGED INSTANCE DOCUMENT (`novaclaw/src/config/config.ts`,
 *    an `InstanceState` keyed by instance directory). It is what every novaclaw service means by
 *    "the config", and until B7 tier-3 nothing refreshed it: `Config.invalidate()` clears only the
 *    process-global store overlay, so the per-instance document stayed at its first-read value for
 *    the life of the process and the ONLY thing that replaced it was the instance being destroyed.
 *    The reload re-runs that merge. Cost is the honest reason its trigger list is SHORT: the merge
 *    re-reads the stores, scans `{command,commands}`/`{plugin,plugins}` under each config directory,
 *    and re-reads the managed-MDM directory — bounded, and strictly cheaper than the location boot
 *    the teardown used to pay, but not free enough to fire on every key.
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

/**
 * Re-materialise one domain for every open location, for a durable write that did NOT come through
 * `apply`.
 *
 * **Why this exists (2026-08-06).** `apply` fires `refreshDomains` itself, so every `PATCH /config`
 * already lands live. Two routes write the catalogue store directly and therefore bypassed it —
 * `provider.remove` and `provider.removeModel` — which is why `provider.remove`'s handler carried the
 * note *"the live per-location catalog snapshot still holds the provider until the next boot"*. That
 * lag was visible as a shipped defect: deleting a model left its row on screen, so the Models tab had
 * to keep a client-side hide purely to cover a staleness we could simply not have.
 *
 * ⚠️ **This is not a second mechanism.** It is the same registry, the same ordering and the same
 * ruling-2 reporting as the config path — deliberately, because a *second* refresh path is exactly
 * the kind of duplicate that drifts. If you find yourself adding a third caller, ask first whether
 * that write belongs in `apply`.
 *
 * ⚠️ A store write must be COMMITTED before calling this: the reload re-reads the store, so firing it
 * inside the transaction would re-materialise the pre-write state and report success for it.
 */
export const refreshDomain = (domain: ReloadDomain) => refreshDomains([domain])

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
/**
 * Which of the consumed keys are stored-but-not-live.
 *
 * ⚠️ `ledger` is a parameter with a default, not a closed-over constant, for ONE reason: the ledger
 * is empty today (see {@link RESTART_REQUIRED_KEYS}), so every assertion about this function over
 * the real ledger is vacuous. `config-reload-order-ledger.test.ts` drives it over a synthetic ledger
 * to prove the mechanism still bites. Production callers pass nothing.
 */
export const restartRequired = (
  consumed: ReadonlySet<string>,
  ledger: ReadonlyMap<string, string> = RESTART_REQUIRED_KEYS,
): string[] => [...ledger.keys()].filter((key) => consumed.has(key))

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
      "config.domains": named,
      "config.causes": failures.map((failure) => Log.fault(failure.cause)),
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
 * independent writes (settings · catalog · agents · commands · references · skills), so a failure
 * at step 5 left steps 1-4 committed and the HTTP handler still answered 200. The list store was
 * worse: it is wipe-then-reinsert, so a failure landing between the delete loop and the insert
 * loop left the skills store EMPTY.
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
 * re-read the same stores per request and reported 8/8 layers active — a guard that was off while
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
 * ignore list to `@novaclaw/host` when the subscription is established, so no read-through can
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
 * instance being destroyed WAS their refresh. No key stays stuck any more — `plugins` was the last
 * one and ruling 5 / step 17 deleted it, so `RESTART_REQUIRED_KEYS` is empty and stays a ledger for
 * the next confession rather than a live one.
 */
/**
 * Where each of these colleagues works right now, folded from its stored layers.
 *
 * ⚠️ Resolved through `AgentWorkspace.folderFor`, so "unset" and "the scratch path spelled out"
 * compare equal — a user who picks the scratch folder explicitly has not moved anybody, and a notice
 * about nothing teaches them to ignore the ones that mean something.
 */
const agentFolders = (names: readonly string[]): Effect.Effect<Map<string, string>, never, AgentConfigStore.Service> =>
  Effect.gen(function* () {
    const folders = new Map<string, string>()
    if (names.length === 0) return folders
    const store = yield* AgentConfigStore.Service
    const stored = yield* store.agents()
    for (const name of names) {
      const layers = stored[name] ?? []
      // LAST layer wins, matching the fold every other reader uses: a later layer overriding an
      // earlier one is what layering means.
      const directory = layers.reduce<string | undefined>((carry, layer) => layer.directory ?? carry, undefined)
      folders.set(name, AgentWorkspace.folderFor({ agentID: name, directory }))
    }
    return folders
  })

export const apply = (patch: Config.Info) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // 🔴 Read the folders BEFORE the write, because a colleague whose project changed has to be told
    // (owner, 2026-08-21: *"reassigning agent to another folder should auto send a message to it, so
    // it won't be thinking it still works on the old project"*). This is the one door every config
    // write passes — the dialog's Save, the `configure` tool, Nova editing a colleague — so it is the
    // only place that can see the change whoever made it. `apply` cannot DELIVER (a store module
    // holds no sessions); it announces, and whatever graph owns sessions has registered to deliver.
    const foldersBefore = yield* agentFolders(Object.keys(patch.agents ?? {}))
    // Same shape as `remove`: succeed WITH the refusal so `orDie` cannot reach it, then re-fail.
    // A caller's refused write is a 400, not a 500 — blaming us for a rule we chose is the
    // `rejectUnknownConfigKeys`-versus-`unroutedKeys` distinction again.
    const outcome = yield* db
      .transaction(() => applyToStores(patch))
      .pipe(
        Effect.catchTag("ConfigStoreWrite.ConfigWriteRefused", (error) => Effect.succeed(error)),
        Effect.orDie,
      )
    if (outcome instanceof ConfigWriteRefused) return yield* Effect.fail(outcome)
    const consumed = outcome
    // Logging's hot path is synchronous, so its Config read-through is a tiny in-memory projection.
    // Refresh only AFTER commit: doing it in SettingsConfigStore.set would let a later router fault
    // roll SQLite back while the live logger kept the rejected value.
    if (consumed.has("log") || consumed.has("trash")) yield* (yield* SettingsConfigStore.Service).all()
    if (consumed.has("offline") || consumed.has("providers") || consumed.has("models")) {
      const before = Offline.currentPolicy()
      const policy = yield* Effect.sync(() => Offline.reload())
      // Log the CHANGE, not the re-read: engaging or releasing an airgap is an operator-visible
      // event, while "saved a provider, airgap still off" is chatter that would bury it.
      if (policyKey(before) !== policyKey(policy))
        yield* Log.event("config.offline.change", {
          "config.offline.enabled": policy.enabled,
          "config.offline.hosts": [...policy.allowedHosts],
        })
    }
    yield* reconcileCommunity(consumed)
    if (consumed.has("watcher")) yield* Watcher.reload()
    // AFTER the commit and after the domain reloads: the colleague is told once its new folder is
    // both durable and live, so a turn woken by the notice reads the folder the notice describes.
    if (consumed.has("agents")) {
      const foldersAfter = yield* agentFolders([...foldersBefore.keys()])
      for (const [agentID, from] of foldersBefore) {
        const to = foldersAfter.get(agentID)
        if (to === undefined || to === from) continue
        yield* AgentReassignment.announce({
          agentID,
          from,
          to,
          ownScratch: AgentWorkspace.isOwnScratch({ agentID, directory: to }),
        })
      }
    }
    // Ruling 2 BEFORE the reloads, not after: the reloads can die ("committed, not live"), and a key
    // this process was never going to apply is a fact the operator needs either way.
    const stuck = restartRequired(consumed)
    if (stuck.length > 0)
      yield* Log.event("config.runtime.restart.required", {
        "config.keys": stuck,
        "config.reasons": stuck.map((key) => RESTART_REQUIRED_KEYS.get(key) ?? key),
      })
    yield* refreshDomains(staleDomains(consumed))
    return consumed
  })

/**
 * The address the user asked us to publish, if any.
 *
 * ⚠️ Read from the value just committed rather than from a schema import: this module is the write
 * path for every store, and pulling the community config's type in here would couple the two.
 */
/**
 * The bootstrap override the user just committed, if any.
 *
 * ⚠️ Absent and empty are different instructions all the way down: absent means "use what shipped",
 * empty means "dial nobody". This preserves that distinction rather than collapsing both to `[]`.
 */
const bootstrapOf = (stored: unknown): { bootstrap?: ReadonlyArray<string> } => {
  const list = (stored as { dht?: { bootstrap?: unknown } } | undefined)?.dht?.bootstrap
  return Array.isArray(list) ? { bootstrap: list.filter((entry): entry is string => typeof entry === "string") } : {}
}

const announceOf = (stored: unknown): { announce?: string } => {
  const announce = (stored as { announce?: unknown } | undefined)?.announce
  return typeof announce === "string" && announce.trim() !== "" ? { announce } : {}
}

/**
 * Settle Community with what was just committed — the process-local consent gate AND the live DHT
 * sidecar — on the post-commit path shared by {@link apply} and {@link remove}.
 *
 * ⚠️ It follows the SAME post-commit path as the airgap, and must: accepting the warning has to take
 * effect on the next call, not the next boot. It is passed the live offline policy rather than
 * importing it, so the two conditions stay independent.
 *
 * 🔴 **The DHT sidecar is brought into line here because "the community is off" was a fact only the
 * settings knew.** The Kademlia node keeps running and keeps republishing this instance's provider
 * record every 12 hours; switching the feature off, engaging the airgap and clearing the published
 * address are three ways to say the same thing to the commons, and none of them reached the process
 * that was talking to it.
 *
 * ⚠️ `offline` is in the condition as well as `community` — the airgap forces the gate shut without
 * any `community` key being written, which is exactly the path that left a node advertising from a
 * machine its owner believed was sealed.
 *
 * 🔴 **And this exists as ONE function because the two callers had DRIFTED** (Codex review
 * NC-SEC-011). `apply` did all of the above; `remove` — the verb whose entire purpose is *"take this
 * back"* — updated only the consent gate and never reconciled the sidecar, and its condition was
 * missing `offline` as well. So `POST /api/config/remove ["community"]` or `["community","announce"]`
 * committed, answered 2xx, and left the node serving and republishing the very address the user had
 * just deleted, until the process was restarted or some later `apply` happened to settle it. The
 * removal was durable, live in the UI, and false to the network. Two copies of a post-commit
 * settlement is how that happens; the fix is not a third copy.
 */
const reconcileCommunity = (consumed: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (!consumed.has("community") && !consumed.has("offline")) return
    // The value as just committed, not a re-read: see `CommunityConsent.applied`.
    const stored = (yield* (yield* SettingsConfigStore.Service).all())["community"]
    const gate = yield* Effect.sync(() => CommunityConsent.applied(stored, Offline.currentPolicy()))
    yield* CommunityDht.reconcile({
      participates: CommunityConsent.participates(gate),
      ...announceOf(stored),
      ...bootstrapOf(stored),
    })
  })

const policyKey = (policy: Offline.Policy) => `${policy.enabled}:${[...policy.allowedHosts].sort().join(",")}`

/**
 * ═══ the REMOVE verb ════════════════════════════════════════════════════════════════════════════
 *
 * v0.2.0 item 4.3, 2026-08-07. **`PATCH /config` merges and never deletes; deletion is a second
 * verb that takes explicit paths.** The `null`-as-tombstone question and why it is refused are
 * argued at the top of `merge-patch.ts` — short version: the patch body is decoded through
 * `Config.Info` BEFORE any merge, so a tombstone would have to be a legal value of the slot it
 * deletes, and making it one is how you *acquire* RFC-7396's ambiguity rather than dodge it.
 *
 * **Why one general verb and not more delete routes.** Five already exist — `agent.remove`,
 * `command.remove`, `reference.remove`, `provider.remove`, `provider.removeModel` — and each closed
 * a real hole. But the route-per-key answer does not reach the end: the map-shaped slots still
 * without one are `mcp.servers.<name>` (the Phase-1 finding this item folds in),
 * `provider_presets.<id>`, `permissions.<object>`, `formatter.<name>`, `tool_routing.tools.<name>`,
 * `local_model_catalog.models.<id>`, `providers.<id>.api.headers.<h>` and
 * `mcp.servers.<n>.environment.<k>` — eight more, several nested two and three levels inside a
 * single settings VALUE, where a dedicated HTTP route would be absurd. Nine routes for nine shapes
 * is nine chances to forget the tenth. One path-addressed verb over the routing table that already
 * exists is the same capability with no per-key surface, and it is what makes AGENTS.md's
 * self-healing law true for the whole config rather than for five lucky keys.
 *
 * ⚠️ **This does NOT retire the five routes.** They are shipped, the UI calls them, and
 * `provider.removeModel` carries a query-parameter design that is load-bearing for ids with
 * slashes. What it does retire is the reason to add a sixth.
 */

/** Why one path could not be removed. `missing` = the path names nothing; `refused` = the shape
 *  cannot be addressed this way and the reason says what to do instead. */
export interface RemovalRefusal {
  readonly path: MergePatch.Path
  readonly kind: "missing" | "refused"
  readonly reason: string
}

/**
 * A removal request that changed nothing, in whole or in part — so the WHOLE request rolled back.
 *
 * v0.2.0 ruling 2, *a failed mutation never reports success*, and the honest answer here is
 * all-or-nothing rather than best-effort. An agent repairing an instance sends the paths it
 * believes are stale; if one of them was never there, the agent's model of the instance is wrong
 * and it needs to know that BEFORE the other three are gone — a 204 for "3 of 4" is the shape that
 * makes a repair loop believe it has finished. `provider.removeModel` already answers a no-op with
 * 404 for exactly this reason; this is the same rule with more than one path in flight.
 */
export class ConfigRemoveRefused extends Schema.TaggedErrorClass<ConfigRemoveRefused>()(
  "ConfigStoreWrite.ConfigRemoveRefused",
  {
    message: Schema.String,
    refusals: Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.String),
        kind: Schema.Literals(["missing", "refused"]),
        reason: Schema.String,
      }),
    ),
  },
) {}

/**
 * A WRITE naming something this surface refuses to store.
 *
 * 🔴 Today that is exactly one thing: the governing agent (AGENTS.md — *"the charter is not editable
 * from inside"*). It exists because the alternative shipped and was measured: `PATCH /config` with
 * `{"agents":{"nova":{"title":"HIJACKED"}}}` answered **200**, stored a row, and the materialiser
 * dropped it — so the route reported success for a change it discarded, and the handler's own
 * comment ("a 200 here means every key in the patch either landed or is a ledgered no-op") became a
 * false description of itself.
 *
 * ⚠️ Refused BEFORE anything is written, so the store never holds the row at all. The drop at
 * materialisation stays as defence in depth against a corrupt or directly-written store row, but a
 * defence that runs after a successful-looking write is not the place to tell the user no.
 */
export class ConfigWriteRefused extends Schema.TaggedErrorClass<ConfigWriteRefused>()(
  "ConfigStoreWrite.ConfigWriteRefused",
  { message: Schema.String, keys: Schema.Array(Schema.String) },
) {}

/** The one place the refusal message is written, so the wire, the log and a test all read the same
 *  sentence — and every offending path is named, because "some path was wrong" is not actionable. */
export const refusalMessage = (refusals: readonly RemovalRefusal[]): string =>
  `config: NOTHING was removed — ${refusals
    .map((refusal) => `${MergePatch.showPath(refusal.path)}: ${refusal.reason}`)
    .join("; ")}. The whole request was rolled back rather than report success for a path that named nothing.`

/**
 * ─── keys the REMOVE verb refuses by name, each with what to send instead ────────────────────────
 *
 * The twin of `NOT_ROUTED_KEYS`, and the same ruling-1 shape: a `Config.Info` key that neither
 * routes for removal nor appears here is a hole that compiles green, so
 * `config-remove-ledger.test.ts` ratchets this map in both directions.
 *
 * ⚠️ Every entry is a redirect, never a shrug. "You cannot delete this" with no next step is the
 * self-healing law failing quietly; each reason names the operation that DOES work.
 */
export const REMOVE_REFUSED_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "$schema",
    "not stored — it describes the FILE, not the instance (see NOT_ROUTED_KEYS), so there is " +
      "nothing to remove. Omit it from the next export and it is gone.",
  ],
  [
    "skills",
    "an ARRAY, and arrays replace wholesale under the merge contract — so `PATCH /config` already " +
      'deletes an entry: send `{"skills": [...]}` without it. Commit 53051cca8 ruled on this and ' +
      "deliberately left the array-shaped keys without delete routes for the same reason.",
  ],
  [
    "models",
    "the FLAT authoring shape, which normalizes into `providers` on write and is never stored under " +
      'this key. Remove the stored entry: `["providers", "<providerID>", "models", "<modelID>"]`.',
  ],
])

/**
 * Route ONE path. Returns the consumed top-level key on success (for the reload triggers), or a
 * refusal naming what went wrong.
 *
 * ⚠️ The first segment is a top-level `Config.Info` key and nothing else. There is no wildcard, no
 * glob and no "remove everything under" form: a repair verb whose blast radius depends on how a
 * pattern happens to match is not a repair verb, and the one destructive mistake this surface could
 * make is the one it must not be able to express.
 */
const removeOne = (
  path: MergePatch.Path,
): Effect.Effect<
  { readonly key: string } | RemovalRefusal,
  never,
  | SettingsConfigStore.Service
  | CatalogStore.Service
  | AgentConfigStore.Service
  | CommandConfigStore.Service
  | ReferenceConfigStore.Service
> =>
  Effect.gen(function* () {
    const refuse = (kind: "missing" | "refused", reason: string): RemovalRefusal => ({ path, kind, reason })
    if (path.length === 0) return refuse("refused", "an empty path names nothing")
    const [key, ...rest] = path as [string, ...string[]]

    const declared = Object.prototype.hasOwnProperty.call(Config.Info.fields, key)
    if (!declared)
      return refuse("refused", `"${key}" is not a config key — GET /config for the keys this instance accepts`)

    const excused = REMOVE_REFUSED_KEYS.get(key)
    if (excused !== undefined) return refuse("refused", excused)

    const layered = LAYERED_ARMS.find((arm) => arm.key === key)
    if (layered !== undefined) {
      if (rest.length === 0)
        return refuse(
          "refused",
          `removing all of "${key}" at once is not expressible — name the entry, e.g. ["${key}", "<name>"]`,
        )
      // 🔴 Removing a PROTECTED agent's stored row is deliberately ALLOWED here, and the distinction
      // is worth stating because it looks like a hole. Nova is seeded in CODE, so deleting its
      // config row does not delete Nova — it RESTORES it to the shipped brief. Refusing that would
      // make a stale override permanently unremovable through the API, which is the self-healing law
      // failing quietly ("restorable by asking an agent, never by hand-editing config files"). The
      // identity is protected by the three things that actually protect it: the WRITE is refused
      // above, the materialiser drops any row that arrives another way, and `DELETE /api/agent/:id`
      // — where the user's intent really is "get rid of this colleague" — answers 400.
      return (yield* layered.remove(rest)) ? { key } : refuse("missing", `no such ${key} entry`)
    }

    // The two singleton default refs. They are settings ROWS, not a nested value, so "remove" means
    // delete the row — an empty string is still a value and would block `setDefaultIfEmpty` forever
    // (commit 53051cca8, which added `clearDefault` for precisely this).
    if (key === "model" || key === "default_agent") {
      if (rest.length > 0) return refuse("refused", `"${key}" is a single value — it has no fields to remove`)
      if (key === "model") {
        const catalog = yield* CatalogStore.Service
        if ((yield* catalog.getDefault()) === undefined) return refuse("missing", "no default model is set")
        yield* catalog.clearDefault()
      } else {
        const agents = yield* AgentConfigStore.Service
        if ((yield* agents.getDefault()) === undefined) return refuse("missing", "no default agent is set")
        yield* agents.clearDefault()
      }
      return { key }
    }

    // Everything else is a settings key: ONE whole JSON value per key in the settings store, so a
    // nested removal is read → prune → write back, and a bare key drops the row.
    if ((SettingsConfigSeed.SETTINGS_KEYS as readonly string[]).includes(key)) {
      const settings = yield* SettingsConfigStore.Service
      const current = yield* settings.all()
      if (current[key] === undefined) return refuse("missing", `"${key}" is not set`)
      if (rest.length === 0) {
        yield* settings.remove(key)
        return { key }
      }
      const pruned = MergePatch.removeAt(current[key], rest)
      // ⚠️ Says "no such value", not "no such key": `removeAt` also returns undefined when a segment
      // tries to index an ARRAY, and calling that "missing" would be true but useless. The array
      // rule is in the ledger; naming the path is what the caller can act on.
      if (pruned === undefined) return refuse("missing", `no such value under "${key}"`)
      yield* settings.set(key, pruned.value)
      return { key }
    }

    // Unreachable while `config-remove-ledger.test.ts` is green: a declared key that is neither
    // layered, nor a default ref, nor a settings key, nor ledgered. Named rather than silently
    // treated as missing, because "was never there" would be a false description of our own gap.
    return refuse("refused", `"${key}" has no removal route — this is a NovaClaw defect, please report it`)
  })

/**
 * Clear a default that now points at something this request removed.
 *
 * ⚠️ **This rule already exists three times** — in `handlers/agent.ts`, `handlers/provider.ts`
 * (twice) — and each copy was written because a dangling default is worse than a missing one: it
 * reads as CONFIGURED and resolves to nothing, so V2 silently falls back to `build` while
 * `packages/novaclaw` throws. A fourth caller that forgot it would re-open that defect through a
 * new door, which is why it is here rather than in the route above. The three handler copies are
 * filed for consolidation; consolidating them is not this item.
 *
 * Conditional, never blanket: removing some OTHER agent or provider must leave the default alone.
 */
const pruneDanglingDefaults = (removed: readonly MergePatch.Path[]) =>
  Effect.gen(function* () {
    const cleared: string[] = []
    const agentNames = removed.filter((path) => path.length === 2 && path[0] === "agents").map((path) => path[1]!)
    if (agentNames.length > 0) {
      const agents = yield* AgentConfigStore.Service
      const current = yield* agents.getDefault()
      if (current !== undefined && agentNames.includes(current)) {
        yield* agents.clearDefault()
        cleared.push("default_agent")
      }
    }
    const catalog = yield* CatalogStore.Service
    const current = yield* catalog.getDefault()
    if (current === undefined) return cleared
    const orphaned = removed.some((path) => {
      if (path[0] !== "providers") return false
      // `["providers", id]` — the whole provider went. `["providers", id, "models", modelID]` — one
      // model went; `refNamesModel` splits the stored ref on the FIRST slash only, because model ids
      // contain slashes of their own.
      if (path.length === 2) return current.startsWith(`${path[1]}/`)
      return path.length === 4 && path[2] === "models" && ModelPrune.refNamesModel(current, path[1]!, path[3]!)
    })
    if (orphaned) {
      yield* catalog.clearDefault()
      cleared.push("model")
    }
    return cleared
  })

/** What a completed `remove` did, so the caller can report it rather than assert it. */
export interface RemovalReport {
  readonly removed: readonly MergePatch.Path[]
  /** Default refs cleared because they pointed at something removed (`model`, `default_agent`). */
  readonly cleared: readonly string[]
}

/**
 * Remove each path, ALL-OR-NOTHING, and make the result live.
 *
 * Structurally the twin of {@link apply}: one `db.transaction`, the same rollback argument, the
 * same post-commit `Offline.reload` / `Watcher.reload` / `refreshDomains` chain keyed off the same
 * `staleDomains` table. That is deliberate — a removal that is durable but not live is the exact
 * "deleted a model, the row is still on screen" defect `refreshDomain` was added to close, and a
 * second refresh path is the kind of duplicate that drifts until the two disagree about what live
 * means.
 *
 * ⚠️ `ConfigRemoveRefused` is caught OUTSIDE the transaction and re-failed, rather than being let
 * through `Effect.orDie`. Failing inside is what rolls the transaction back; `orDie` would convert
 * a caller's bad path into a 500, blaming us for their typo — the same distinction
 * `rejectUnknownConfigKeys` draws against `unroutedKeys`.
 */
export const remove = (
  paths: readonly MergePatch.Path[],
): Effect.Effect<
  RemovalReport,
  ConfigRemoveRefused,
  | Database.Service
  | SettingsConfigStore.Service
  | CatalogStore.Service
  | AgentConfigStore.Service
  | CommandConfigStore.Service
  | ReferenceConfigStore.Service
> =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const outcome = yield* db
      .transaction(() =>
        Effect.gen(function* () {
          const refusals: RemovalRefusal[] = []
          const consumed = new Set<string>()
          for (const path of paths) {
            const result = yield* removeOne(path)
            if ("kind" in result) refusals.push(result)
            else consumed.add(result.key)
          }
          if (paths.length === 0)
            refusals.push({ path: [], kind: "refused", reason: "no paths were given, so nothing was removed" })
          if (refusals.length > 0)
            return yield* Effect.fail(new ConfigRemoveRefused({ message: refusalMessage(refusals), refusals }))
          const cleared = yield* pruneDanglingDefaults(paths)
          for (const key of cleared) consumed.add(key)
          return { consumed, cleared }
        }),
      )
      .pipe(
        // Succeed with the error so the `orDie` below cannot reach it, then re-fail. The transaction
        // has already rolled back at this point — it keys on the body's Exit, not on this.
        Effect.catchTag("ConfigStoreWrite.ConfigRemoveRefused", (error) => Effect.succeed(error)),
        Effect.orDie,
      )
    if (outcome instanceof ConfigRemoveRefused) return yield* Effect.fail(outcome)

    const { consumed, cleared } = outcome
    if (consumed.has("log")) yield* (yield* SettingsConfigStore.Service).all()
    if (consumed.has("offline") || consumed.has("providers") || consumed.has("models")) {
      const before = Offline.currentPolicy()
      const policy = yield* Effect.sync(() => Offline.reload())
      if (policyKey(before) !== policyKey(policy))
        yield* Log.event("config.offline.change", {
          "config.offline.enabled": policy.enabled,
          "config.offline.hosts": [...policy.allowedHosts],
        })
    }
    yield* reconcileCommunity(consumed)
    if (consumed.has("watcher")) yield* Watcher.reload()
    const stuck = restartRequired(consumed)
    if (stuck.length > 0)
      yield* Log.event("config.runtime.restart.required", {
        "config.keys": stuck,
        "config.reasons": stuck.map((key) => RESTART_REQUIRED_KEYS.get(key) ?? key),
      })
    yield* Log.event("config.remove.applied", {
      // ⚠️ A `MergePatch.Path` is itself a `string[]`, so the old `JSON.stringify(paths)` produced a
      // NESTED array nobody could grep. `showPath` is the rendering this module already uses in its
      // refusal messages — one readable element per removed path, and now one source for both.
      "config.paths": paths.map(MergePatch.showPath),
      "config.cleared": cleared,
    })
    yield* refreshDomains(staleDomains(consumed))
    return { removed: paths, cleared }
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

    return result
  })
