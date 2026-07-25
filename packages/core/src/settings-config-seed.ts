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
  "paranoid",
  "watcher",
  "formatter",
  "attachments",
  "tool_output",
  "mcp",
  "compaction",
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
  "experimental",
] as const satisfies readonly (keyof Config.Info)[]

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/**
 * Decode a store snapshot into the synthetic `Config.Info` the Config layer appends to
 * `entries()`. Unknown/extra keys are dropped by the decode; a snapshot that fails to decode
 * yields undefined (defensive — a hand-corrupted row must not take the location down).
 */
export function settingsInfoFromStore(values: Record<string, unknown>): Config.Info | undefined {
  const filtered: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS) if (values[key] !== undefined) filtered[key] = values[key]
  if (Object.keys(filtered).length === 0) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(filtered))
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

/** A top-level config key dropped at import time because it failed schema validation. */
export type SkippedConfigKey = {
  /** The offending top-level key, or "*" when the whole file could not be parsed. */
  key: string
  /** The file the key came from (or `NOVACLAW_CONFIG_CONTENT` for the inline env source). */
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

function formatSkippedNotice(skipped: readonly SkippedConfigKey[]): string {
  const plural = skipped.length === 1 ? "" : "s"
  const head =
    `Config partially applied: ${skipped.length} key${plural} skipped because ` +
    `${skipped.length === 1 ? "it" : "they"} failed validation. The rest of your config was applied — ` +
    `fix the below and restart to apply:`
  return [head, ...skipped.map((entry) => `  - ${entry.key} (${entry.source}): ${entry.reason}`)].join("\n")
}

// The server-startup variant (the sibling-seed template): imports from the global config dir +
// the LAUNCH directory BEFORE any location boots — without it, a scratch location booting first
// would seed from global-only entries and the launch jsonc's settings would never import
// (the store is non-empty by then). Idempotent: a no-op once any setting is stored. Returns the
// keys it had to skip (also logged as a non-blocking startup notice) so a caller/test can react.
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* SettingsConfigStore.Service
    if (!(yield* store.isEmpty())) return [] as SkippedConfigKey[]
    const fs = yield* FSUtil.Service

    const infos: Config.Info[] = []
    const skipped: SkippedConfigKey[] = []
    for (const dir of [globalConfigDir, directory])
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
