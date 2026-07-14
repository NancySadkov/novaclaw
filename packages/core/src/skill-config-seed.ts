export * as SkillConfigSeed from "./skill-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { SkillConfigStore } from "./skill-config-store"
import { Config } from "./config"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

/**
 * Normalize one config `skills` entry for instance-wide storage: URLs pass through; local
 * paths become ABSOLUTE, resolved against the DECLARING file's directory (`~/` against home).
 * A stored relative path would re-resolve differently in every location — nondeterministic
 * for an instance-wide setting.
 */
export function resolveSkillSource(declaringDir: string, home: string, item: string) {
  if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) return item
  const expanded = item.startsWith("~/") ? path.join(home, item.slice(2)) : item
  // join, not resolve — the historical loader's exact semantics (resolve would drive-prefix
  // a rooted posix-style path on Windows).
  return path.isAbsolute(expanded) ? expanded : path.join(declaringDir, expanded)
}

// Config→SQLite step 4: the transitional jsonc IMPORT for skill discovery sources (the
// catalog/agent/command-seed template). Reads `skills` entries from the global config dir + the
// launch directory's novaclaw.jsonc (+ NOVACLAW_CONFIG_CONTENT) into the instance-wide
// `SkillConfigStore` at server startup, BEFORE any location boots. Idempotent: a no-op once the
// store holds any source. The `skill(s)/` directory walk is NOT imported (locked decision D2).
export const seedFromDirectory = (globalConfigDir: string, directory: string, home: string) =>
  Effect.gen(function* () {
    const store = yield* SkillConfigStore.Service
    if (!(yield* store.isEmpty())) return
    const fs = yield* FSUtil.Service

    const decodeText = (text: string | undefined) => {
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(decodeInfo(input))
    }

    // Global config first, then the launch directory, then NOVACLAW_CONFIG_CONTENT (resolved
    // against the launch directory) — the same order as the sibling seeds.
    const sources: { declaringDir: string; info: Config.Info }[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = decodeText(yield* fs.readFileStringSafe(path.join(dir, name)))
        if (info) sources.push({ declaringDir: dir, info })
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) sources.push({ declaringDir: directory, info: inline })

    for (const { declaringDir, info } of sources)
      for (const item of info.skills ?? []) yield* store.addSource(resolveSkillSource(declaringDir, home, item))
  })
