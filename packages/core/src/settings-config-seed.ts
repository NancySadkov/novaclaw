export * as SettingsConfigSeed from "./settings-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Config } from "./config"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { SettingsConfigStore } from "./settings-config-store"

// NOTE: config.ts imports this module (the layer runs the seed + synthetic-doc build), so all
// Config.Info schema derivations stay INSIDE function bodies — a module-level derivation would
// touch the half-evaluated Config namespace in the import cycle.
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

/**
 * The runtime-settings keys that live in the instance-wide `SettingsConfigStore` (config-sqlite
 * step 6). Every key here has WHOLE-VALUE `Config.latest()` semantics — the last document
 * holding the key wins — so the store keeps one value per key and the Config layer surfaces
 * them through one synthetic document appended to `entries()`.
 *
 * Deliberately EXCLUDED:
 * - `model` + `default_agent` — owned by the Catalog/AgentConfig stores (steps 1-2).
 * - `agents`/`commands`/`skills`/`references`/`plugins`/`providers`/`disabled_providers`/
 *   `enabled_providers` — migrated per-subsystem stores (steps 1-5).
 * - `permissions` + `instructions` — CONCAT-across-documents semantics (not latest()); moving
 *   them through a synthetic doc would double-apply while jsonc documents still load. They stay
 *   document-read until step 8 retires jsonc-as-runtime-source.
 * - `experimental` — the policies pipeline + experimental handler (step 9).
 */
export const SETTINGS_KEYS = [
  "shell",
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
  "persona",
  "user_profile",
  "introspection",
  "adhoc_tools",
  "affective",
  "strict",
  "offline",
  "kb",
  "quality",
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

/**
 * The transitional jsonc IMPORT for runtime settings (config-sqlite step 6): store each
 * settings key's `Config.latest()` value from the given document entries. Runs inside the
 * Config layer on first boot (isEmpty-gated there); step 8 removes it. Encoded (plain-JSON)
 * values go into the store so the later synthetic-document decode round-trips.
 */
export const seedFromEntries = (entries: readonly Config.Entry[]) =>
  seedFromInfos(entries.filter((entry): entry is Config.Document => entry.type === "document").map((doc) => doc.info))

const seedFromInfos = (infos: readonly Config.Info[]) =>
  Effect.gen(function* () {
    const store = yield* SettingsConfigStore.Service
    const encodeInfo = Schema.encodeSync(Config.Info)
    // Encode each document back to plain JSON (field values may be Schema.Class instances),
    // then replicate latest() per key over the plain objects — the stored value must be plain
    // so the later synthetic-document decode round-trips.
    const plains = infos.map((info) => encodeInfo(info) as Record<string, unknown>)
    for (const key of SETTINGS_KEYS) {
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
