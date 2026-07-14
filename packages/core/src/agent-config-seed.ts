export * as AgentConfigSeed from "./agent-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

// Config→SQLite step 2: the transitional jsonc IMPORT for agents (the catalog-seed template).
// Reads config-file agent definitions + `default_agent` from the global config dir + the launch
// directory's novaclaw.jsonc and writes them into the instance-wide `AgentConfigStore`, so agent
// config no longer depends on reading jsonc per-location at runtime. Runs once at server startup
// BEFORE any location boots — the shared scratch dir (and every other dir) then resolves the same
// agents. Idempotent: a no-op once the store holds any agent. Markdown agents are NOT imported —
// they stay filesystem-walked (locked decision D2). Requires FSUtil + AgentConfigStore in context.
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* AgentConfigStore.Service
    const agentsSeeded = !(yield* store.isEmpty())
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
    // then NOVACLAW_CONFIG_CONTENT (most specific) — the same order as the catalog seed.
    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = yield* loadInfo(path.join(dir, name))
        if (info) infos.push(info)
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) infos.push(inline)
    if (infos.length === 0) return

    // Agent layers import only ONCE (idempotence gate) — a user's later store edits must win.
    if (!agentsSeeded) {
      const layers: Record<string, ConfigAgent.Info[]> = {}
      for (const info of infos)
        for (const [name, item] of Object.entries(info.agents ?? {})) (layers[name] ??= []).push(item)
      for (const [name, agentLayers] of Object.entries(layers)) yield* store.setLayers(name, agentLayers)
    }

    // The default-agent import must NOT hide behind the agents gate (same reasoning as the
    // default-model import): a store seeded before the config gained a `default_agent` would
    // otherwise freeze default-less forever. setDefaultIfEmpty protects a user-set default.
    let defaultAgent: string | undefined
    for (const info of infos) if (info.default_agent !== undefined) defaultAgent = info.default_agent
    if (defaultAgent !== undefined) yield* store.setDefaultIfEmpty(defaultAgent)
  })
