export * as SettingsConfigSeed from "./settings-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
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
  "kb",
  "quality",
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

// The server-startup variant (the sibling-seed template): imports from the global config dir +
// the LAUNCH directory BEFORE any location boots — without it, a scratch location booting first
// would seed from global-only entries and the launch jsonc's settings would never import
// (the store is non-empty by then). Idempotent: a no-op once any setting is stored.
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* SettingsConfigStore.Service
    if (!(yield* store.isEmpty())) return
    const fs = yield* FSUtil.Service

    const decodeText = (text: string | undefined) => {
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(input))
    }

    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = decodeText(yield* fs.readFileStringSafe(path.join(dir, name)))
        if (info) infos.push(info)
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) infos.push(inline)
    if (infos.length === 0) return

    yield* seedFromInfos(infos)
  })
