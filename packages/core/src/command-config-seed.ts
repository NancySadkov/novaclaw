export * as CommandConfigSeed from "./command-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigCommand } from "./config/command"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

// Config→SQLite step 3: the transitional jsonc IMPORT for commands (the catalog/agent-seed
// template). Reads config-file command definitions from the global config dir + the launch
// directory's novaclaw.jsonc (+ NOVACLAW_CONFIG_CONTENT) into the instance-wide
// `CommandConfigStore` at server startup, BEFORE any location boots. Idempotent: a no-op once the
// store holds any command. Markdown commands are NOT imported (locked decision D2).
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* CommandConfigStore.Service
    if (!(yield* store.isEmpty())) return
    const fs = yield* FSUtil.Service

    const decodeText = (text: string | undefined) => {
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(decodeInfo(input))
    }

    const loadInfo = (filepath: string) =>
      Effect.gen(function* () {
        return decodeText(yield* fs.readFileStringSafe(filepath))
      })

    // Global config first (general), then the target directory (specific — wins on conflicts),
    // then NOVACLAW_CONFIG_CONTENT (most specific) — the same order as the catalog/agent seeds.
    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = yield* loadInfo(path.join(dir, name))
        if (info) infos.push(info)
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) infos.push(inline)
    if (infos.length === 0) return

    const layers: Record<string, ConfigCommand.Info[]> = {}
    for (const info of infos)
      for (const [name, item] of Object.entries(info.commands ?? {})) (layers[name] ??= []).push(item)
    for (const [name, commandLayers] of Object.entries(layers)) yield* store.setLayers(name, commandLayers)
  })
