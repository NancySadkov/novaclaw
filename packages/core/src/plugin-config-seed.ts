export * as PluginConfigSeed from "./plugin-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option, Schema } from "effect"
import { PluginConfigStore, type PluginConfigEntry } from "./plugin-config-store"
import { Config } from "./config"
import type { ConfigPlugin } from "./config/plugin"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

/**
 * Normalize one config `plugins` entry for instance-wide storage: bare npm package names pass
 * through; `file://` URLs and `./`/`../` relative paths become ABSOLUTE paths, resolved against
 * the DECLARING file's directory — the same resolution the loader historically applied per
 * document (a stored relative spec would re-resolve differently in every location).
 */
export function normalizePluginEntry(declaringDir: string, item: ConfigPlugin.Plugin): PluginConfigEntry {
  const ref = typeof item === "string" ? { package: item } : item
  const pkg = (() => {
    if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
    if (ref.package.startsWith("./") || ref.package.startsWith("../")) return path.resolve(declaringDir, ref.package)
    return ref.package
  })()
  return { package: pkg, ...(ref.options ? { options: ref.options } : {}) }
}

// Config→SQLite step 5: the transitional jsonc IMPORT for external plugin specs (the
// catalog/agent/command/skill-seed template). Reads `plugins` entries from the global config dir
// + the launch directory's novaclaw.jsonc (+ NOVACLAW_CONFIG_CONTENT) into the instance-wide
// `PluginConfigStore` at server startup, BEFORE any location boots. Idempotent: a no-op once the
// store holds any spec. Plugin FILES under `{plugin,plugins}/` are NOT imported (the D2 analog).
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* PluginConfigStore.Service
    if (!(yield* store.isEmpty())) return
    const fs = yield* FSUtil.Service

    const decodeText = (text: string | undefined) => {
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(decodeInfo(input))
    }

    // Global config first (general), then the launch directory (specific — wins on conflicts),
    // then NOVACLAW_CONFIG_CONTENT (resolved against the launch directory).
    const sources: { declaringDir: string; info: Config.Info }[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = decodeText(yield* fs.readFileStringSafe(path.join(dir, name)))
        if (info) sources.push({ declaringDir: dir, info })
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) sources.push({ declaringDir: directory, info: inline })

    for (const { declaringDir, info } of sources)
      for (const item of info.plugins ?? []) yield* store.setPlugin(normalizePluginEntry(declaringDir, item))
  })
