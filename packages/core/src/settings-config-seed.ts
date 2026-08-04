export * as SettingsConfigSeed from "./settings-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Cause, Effect, Exit, Option, Schema, SchemaIssue } from "effect"
import { Config } from "./config"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { MergePatch } from "./merge-patch"
import { SettingsConfigStore } from "./settings-config-store"

// NOTE: config.ts imports this module (the layer runs the seed + synthetic-doc build), so all
// Config.Info schema derivations stay INSIDE function bodies — a module-level derivation would
// touch the half-evaluated Config namespace in the import cycle.
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

/**
 * The runtime-settings keys that live in the instance-wide `SettingsConfigStore` (config-sqlite
 * steps 6 + 8c). Most keys have WHOLE-VALUE `Config.latest()` semantics; two carry their own
 * import folding (see `seedFromInfos`): `permissions` CONCATS across documents (general first,
 * specific last — the agent plugin's historical flatMap order) and `experimental` deep-merges,
 * with `policies` REVERSE-concatenated (the policy loader's historical user-global-overrides-
 * repository order). Post-8c the runtime reads all of them from ONE synthetic document, so the
 * multi-document semantics only matter at import time.
 *
 * Deliberately EXCLUDED:
 * - `model` + `default_agent` — owned by the Catalog/AgentConfig stores (steps 1-2).
 * - `agents`/`commands`/`skills`/`references`/`plugins`/`providers` — per-subsystem stores.
 *
 * Step 9 moved the last three V1-side keys in: `instructions` CONCAT+dedups across documents
 * (the V1 service's historical Set union); `disabled_providers`/`enabled_providers` are
 * whole-value (last document wins — mergeDeep replaced arrays).
 */
export const SETTINGS_KEYS = [
  "shell",
  "expertise",
  "virtualFs",
  "folder_bookmarks",
  "instances",
  "instructions",
  "disabled_providers",
  "enabled_providers",
  "autoupdate",
  "username",
  "server",
  "snapshots",
  "watcher",
  "formatter",
  "attachments",
  "tool_output",
  "tool_routing",
  "resource_pressure",
  "mcp",
  "compaction",
  "context",
  "provider_connection",
  "permissions",
  "persona",
  "user_profile",
  "introspection",
  "adhoc_tools",
  "affective",
  "strict",
  "offline",
  "telemetry",
  "memory",
  "quality",
  "web_search",
  "provider_presets",
  "local_model_catalog",
  "experimental",
] as const satisfies readonly (keyof Config.Info)[]

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/** The synthetic settings document, plus every key the snapshot could not apply verbatim. */
export type SettingsFromStore = {
  /** The synthetic document, or undefined when the store held nothing usable. */
  info?: Config.Info
  /**
   * Keys that failed validation. Non-empty means the running instance does NOT match what the
   * user configured, so a caller MUST surface it (`formatSkippedNotice` + a log/notice) rather
   * than discard it — a silent salvage is only marginally better than a silent total loss.
   */
  skipped: SkippedConfigKey[]
}

/** `SkippedConfigKey.source` for rows read back out of the settings store (vs. an import file). */
const STORE_SOURCE = "settings store"

/**
 * The fail-closed stand-in prepended to a `permissions` ruleset that did not fully decode.
 * `ask`, not `deny`: see the PERMISSIONS note on `settingsInfoFromStore`.
 */
const PERMISSIONS_BACKSTOP = { action: "*", resource: "*", effect: "ask" } as const

/**
 * Decode a store snapshot into the synthetic `Config.Info` the Config layer appends to
 * `entries()`. Unknown/extra keys are dropped by the decode (`onExcessProperty: "ignore"`).
 *
 * PER-KEY, like `decodeText` below — and for the same reason, only worse on this path. A whole-
 * document decode meant ONE bad row silently discarded all of `SETTINGS_KEYS` at once, reverting
 * `permissions`, `offline`, `shell`, `persona`, `mcp` and the telemetry choice to compiled defaults
 * together, with nothing logged. So: whole-document fast path (the overwhelmingly common all-valid
 * snapshot, byte-for-byte the old behaviour), then a salvage that keeps every key which decodes on
 * its own and NAMES the rest in `skipped`.
 *
 * ⚠️ PERMISSIONS IS FAIL-CLOSED, and is the one key that does not simply get dropped. It is the
 * only settings key whose ABSENCE is more permissive than its presence: every agent's ruleset opens
 * with the compiled baseline and the store's rules are appended AFTER it (config/plugin/agent.ts),
 * and rules resolve by findLast — so dropping the key promotes the user's denies to whatever the
 * baseline says. That is a loosening caused by a corrupt row, which is exactly the failure this
 * function must not have. ⚠️ v0.2.0 B4c made the baseline an ambient-safe ALLOWLIST rather than a
 * catch-all `* -> allow`, which shrinks how much a dropped key gives away — it no longer hands back
 * `bash` — but does not remove the problem: the baseline still allows `read`/`explore`/`todowrite`,
 * and the session's permission MODE is appended after the config rules regardless, so a user deny the
 * mode also names is still lost with the key. Since rules resolve by findLast we can be restrictive
 * without discarding what IS readable:
 *   1. keep each individual rule that still decodes, in order — that is the user's literal, readable
 *      intent, and honouring it is strictly closer to what they asked for than dropping the lot; and
 *   2. PREPEND a catch-all `ask`, which outranks the agent's baseline allows but is outranked by
 *      every salvaged rule. Whatever the unreadable rule governed therefore lands on the human
 *      instead of on the baseline.
 * NOT `deny` (which `permission.ts` uses for a missing AGENT): a blanket deny leaves the instance
 * unable to do anything — including repair itself — and AGENTS.md's self-healing law requires the
 * repair path to survive; `ask` is the most restrictive reading that still leaves a person able to
 * say yes. An explicit `permissionMode` of `bypass` still outranks it, as it outranks any config
 * rule — that is a deliberate user choice, not a corrupt row.
 */
export function settingsInfoFromStore(values: Record<string, unknown>): SettingsFromStore {
  const filtered: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS) if (values[key] !== undefined) filtered[key] = values[key]
  if (Object.keys(filtered).length === 0) return { skipped: [] }

  const whole = Schema.decodeUnknownExit(Config.Info)(filtered, DECODE_OPTIONS)
  if (Exit.isSuccess(whole)) return { info: whole.value, skipped: [] }

  const kept: Record<string, unknown> = {}
  const skipped: SkippedConfigKey[] = []
  for (const [key, value] of Object.entries(filtered)) {
    const one = Schema.decodeUnknownExit(Config.Info)({ [key]: value }, DECODE_OPTIONS)
    if (Exit.isSuccess(one)) {
      kept[key] = value
      continue
    }
    if (key === "permissions") {
      kept[key] = salvagePermissions(value, skipped)
      continue
    }
    skipped.push({ key, source: STORE_SOURCE, reason: decodeFailureReason(one.cause) })
  }

  const info =
    Object.keys(kept).length === 0
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(kept))
  // Should be unreachable — every kept key decoded alone and `Config.Info`'s fields are independent
  // — but if the salvaged subset still fails, say so instead of returning a silent undefined.
  if (info === undefined && Object.keys(kept).length > 0)
    skipped.push({
      key: "*",
      source: STORE_SOURCE,
      reason:
        "the snapshot failed to decode even after per-key salvage — " +
        "every stored setting fell back to its built-in default",
    })
  return { info, skipped }
}

/**
 * The `permissions` arm of the salvage: keep the rules that still validate and prepend the
 * fail-closed backstop. Always returns a non-empty ruleset, so the key can never go missing (the
 * missing case is the loosening). Records ONE skipped entry describing what was lost.
 */
function salvagePermissions(value: unknown, skipped: SkippedConfigKey[]): readonly unknown[] {
  const rules: unknown[] = Array.isArray(value) ? value : []
  const usable = rules.filter((rule) =>
    Exit.isSuccess(Schema.decodeUnknownExit(Config.Info)({ permissions: [rule] }, DECODE_OPTIONS)),
  )
  const lost = rules.length - usable.length
  const what = Array.isArray(value)
    ? `${lost} of ${rules.length} permission rule${rules.length === 1 ? "" : "s"} failed validation`
    : "the stored value is not a list of permission rules"
  skipped.push({
    key: "permissions",
    source: STORE_SOURCE,
    reason:
      `${what} — the readable rules were KEPT and a fail-closed catch-all "ask" rule was prepended, ` +
      `so anything the unreadable rules may have denied now asks you instead of running unchecked`,
  })
  return [PERMISSIONS_BACKSTOP, ...usable]
}

const seedFromInfos = (infos: readonly Config.Info[]) =>
  Effect.gen(function* () {
    const store = yield* SettingsConfigStore.Service
    const encodeInfo = Schema.encodeSync(Config.Info)
    // Encode each document back to plain JSON (field values may be Schema.Class instances),
    // then replicate each key's historical multi-document folding over the plain objects —
    // the stored value must be plain so the later synthetic-document decode round-trips.
    const plains = infos.map((info) => encodeInfo(info) as Record<string, unknown>)
    for (const key of SETTINGS_KEYS) {
      if (key === "permissions") {
        // Concat in document order (general first, specific last) — the agent plugin's
        // historical `files.flatMap(info.permissions)`.
        const rules = plains.flatMap((info) => (info.permissions as unknown[] | undefined) ?? [])
        if (rules.length > 0) yield* store.set(key, rules)
        continue
      }
      if (key === "instructions") {
        // Concat + dedup in document order — the V1 config service's historical
        // `Array.from(new Set([...target, ...source]))` union across sources.
        const items = plains.flatMap((info) => (info.instructions as string[] | undefined) ?? [])
        if (items.length > 0) yield* store.set(key, Array.from(new Set(items)))
        continue
      }
      if (key === "experimental") {
        // Fields deep-merge in document order; `policies` REVERSE-concatenate (the policy
        // loader's historical toReversed().flatMap — a user-global rule overrides a
        // repository rule).
        const values = plains
          .map((info) => info.experimental)
          .filter((value): value is Record<string, unknown> => value !== undefined)
        if (values.length === 0) continue
        const merged = values.reduce<unknown>((acc, value) => MergePatch.mergePatch(acc, value), undefined) as Record<
          string,
          unknown
        >
        const policies = [...values].reverse().flatMap((value) => (value.policies as unknown[] | undefined) ?? [])
        if (policies.length > 0) merged.policies = policies
        yield* store.set(key, merged)
        continue
      }
      const value = plains.findLast((info) => info[key] !== undefined)?.[key]
      if (value !== undefined) yield* store.set(key, value)
    }
  })

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]

/**
 * A top-level config key that failed schema validation, so it could not be applied verbatim —
 * either dropped (the import path, and every store key except one) or partially salvaged
 * (`permissions`, which is fail-closed rather than dropped; see `settingsInfoFromStore`).
 */
export type SkippedConfigKey = {
  /** The offending top-level key, or "*" when the whole file could not be parsed. */
  key: string
  /**
   * Where the key came from: the config file's path, `NOVACLAW_CONFIG_CONTENT` for the inline env
   * source, or `"settings store"` for a row read back out of SQLite.
   */
  source: string
  /** A short, human-readable reason the key was dropped. */
  reason: string
}

// Format an Effect decode failure into a short human-readable reason — mirrors ConfigParse.schema's
// standard-schema formatting so the seed notice and the Import error read the same way.
function decodeFailureReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const messages = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => issue.message)
    if (messages.length > 0) return messages.join("; ")
  }
  return String(error)
}

// Decode one document PER-KEY so a single malformed key can't discard the whole file. Every
// Config.Info field is optional, so a single-key object is a valid probe: keep the keys that
// validate and report the rest. The all-valid case (overwhelmingly common) takes the whole-document
// fast path and is byte-for-byte the old behaviour. Unknown keys stay silently ignored
// (onExcessProperty: "ignore") — only KNOWN keys that fail validation are reported as skipped.
//
// ⚠️ **The WIRE deliberately disagrees with this line, since 2026-07-29 — do not "fix" the
// inconsistency by making either side match the other.** `PATCH /config` and `PATCH /global/config`
// now REFUSE an undeclared top-level key with a 400 that names it
// (`rejectUnknownConfigKeys` in packages/novaclaw/src/server/routes/instance/httpapi/groups/config.ts),
// because accepting one and answering 200 is todo.md ruling 2's *a failed mutation never reports
// success* on the surface AGENTS.md's self-healing law depends on: an agent that PATCHes a typo'd
// key, gets 200, re-reads and finds nothing cannot tell a typo from a broken instance, so it loops.
// The divergence is the point, not an oversight — the two paths have different authors and different
// moments:
//  · a FILE is hand-authored, may have been written for any version of NovaClaw, and is applied at
//    BOOT, where there is no caller to answer and refusing it would leave the instance unconfigured
//    over one stale key. Ignoring is the recoverable behaviour here.
//  · a PATCH is a deliberate mutation with a LIVE caller — a user in Settings, or an agent repairing
//    the instance — who can act on "that key does not exist" and cannot act on silence.
// If this line ever needs to change, the honest change is REPORTING an unknown key as a skipped key
// (it already has a notice channel: `SkippedConfigKey` + `formatSkippedNotice`), never making the
// wire lenient again.
function decodeText(text: string | undefined, source: string): { info?: Config.Info; skipped: SkippedConfigKey[] } {
  if (!text) return { skipped: [] }
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length)
    return { skipped: [{ key: "*", source, reason: "not valid JSON/JSONC — the whole file was skipped" }] }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { skipped: [{ key: "*", source, reason: "config must be a JSON object — the whole file was skipped" }] }

  const whole = Schema.decodeUnknownExit(Config.Info)(input, DECODE_OPTIONS)
  if (Exit.isSuccess(whole)) return { info: whole.value, skipped: [] }

  const kept: Record<string, unknown> = {}
  const skipped: SkippedConfigKey[] = []
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const one = Schema.decodeUnknownExit(Config.Info)({ [key]: value }, DECODE_OPTIONS)
    if (Exit.isSuccess(one)) {
      kept[key] = value
      continue
    }
    skipped.push({ key, source, reason: decodeFailureReason(one.cause) })
  }
  const info =
    Object.keys(kept).length === 0
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(kept))
  return { info, skipped }
}

/**
 * The one notice format for a partially-applied config, shared by the import seed and the
 * store read (`settingsInfoFromStore`) so both read the same way to a user.
 */
export function formatSkippedNotice(skipped: readonly SkippedConfigKey[]): string {
  const plural = skipped.length === 1 ? "" : "s"
  const head =
    `Config partially applied: ${skipped.length} key${plural} failed validation. Everything that ` +
    `could be read was applied — fix the below and restart to apply:`
  return [head, ...skipped.map((entry) => `  - ${entry.key} (${entry.source}): ${entry.reason}`)].join("\n")
}

// The server-startup variant (the sibling-seed template): imports from the global config dir BEFORE
// any location boots, so every location — including the shared scratch dir — sees the same settings
// rather than whichever one happened to boot first.
// Idempotent: a no-op once any setting is stored. Returns the
// keys it had to skip (also logged as a non-blocking startup notice) so a caller/test can react.
export const seedFromDirectory = (globalConfigDir: string) =>
  Effect.gen(function* () {
    const store = yield* SettingsConfigStore.Service
    if (!(yield* store.isEmpty())) return [] as SkippedConfigKey[]
    const fs = yield* FSUtil.Service

    const infos: Config.Info[] = []
    const skipped: SkippedConfigKey[] = []
    for (const dir of [globalConfigDir])
      for (const name of NAMES) {
        const source = path.join(dir, name)
        const result = decodeText(yield* fs.readFileStringSafe(source), source)
        if (result.info) infos.push(result.info)
        skipped.push(...result.skipped)
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT, "NOVACLAW_CONFIG_CONTENT")
    if (inline.info) infos.push(inline.info)
    skipped.push(...inline.skipped)

    // A partially-invalid config still applies its valid keys — tell the user what was dropped and
    // why. Non-blocking by contract: this seed is Effect.ignore-wrapped and must never fault
    // startup, so we log a notice rather than throw.
    if (skipped.length > 0) yield* Effect.logWarning(formatSkippedNotice(skipped))

    if (infos.length > 0) yield* seedFromInfos(infos)
    return skipped
  })
