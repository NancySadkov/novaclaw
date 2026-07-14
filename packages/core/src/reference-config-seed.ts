export * as ReferenceConfigSeed from "./reference-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { ReferenceConfigStore } from "./reference-config-store"
import { Config } from "./config"
import { ConfigReference } from "./config/reference"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

function isLocal(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

/**
 * Normalize one reference entry for instance-wide storage: git entries pass through; LOCAL
 * entries become the `{ path }` OBJECT form with an ABSOLUTE path, resolved against the
 * DECLARING file's directory (`~/` against home). Two reasons: a stored relative path would
 * re-resolve differently per location, and a bare absolute-path STRING would misclassify as a
 * git remote on Windows (`C:/…` fails the leading `./~` local test).
 */
export function normalizeReferenceEntry(
  declaringDir: string,
  home: string,
  entry: ConfigReference.Entry,
): ConfigReference.Entry {
  if (!isLocal(entry)) return entry
  const raw = typeof entry === "string" ? entry : entry.path
  const resolved = raw.startsWith("~/")
    ? path.join(home, raw.slice(2))
    : path.isAbsolute(raw)
      ? raw
      : path.resolve(declaringDir, raw)
  if (typeof entry === "string") return ConfigReference.Local.make({ path: resolved })
  return ConfigReference.Local.make({ ...entry, path: resolved })
}

// Config→SQLite step 4: the transitional jsonc IMPORT for reference aliases (the
// catalog/agent/command-seed template). Reads `references` records from the global config dir +
// the launch directory's novaclaw.jsonc (+ NOVACLAW_CONFIG_CONTENT) into the instance-wide
// `ReferenceConfigStore` at server startup, BEFORE any location boots. Idempotent: a no-op once
// the store holds any alias.
export const seedFromDirectory = (globalConfigDir: string, directory: string, home: string) =>
  Effect.gen(function* () {
    const store = yield* ReferenceConfigStore.Service
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

    const layers: Record<string, ConfigReference.Entry[]> = {}
    for (const { declaringDir, info } of sources)
      for (const [name, entry] of Object.entries(info.references ?? {})) {
        if (!ConfigReference.validAlias(name)) continue
        ;(layers[name] ??= []).push(normalizeReferenceEntry(declaringDir, home, entry))
      }
    for (const [name, referenceLayers] of Object.entries(layers)) yield* store.setLayers(name, referenceLayers)
  })
