export * as CatalogSeed from "./catalog-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { CatalogStore } from "./catalog-store"
import { Config } from "./config"
import { ConfigProvider } from "./config/provider"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { ProviderV2 } from "./provider"

const NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

// Settings → SQLite migration: the transitional jsonc IMPORT. Reads providers/models/default from the
// global config dir + a target directory's `novaclaw.jsonc` and writes them into the instance-wide
// `CatalogStore`, so the catalog no longer depends on reading jsonc per-location at runtime. Runs once at
// server startup against the launch directory (see the server's catalog-seed startup layer) — BEFORE any
// location boots, which is what lets the shared scratch dir (and every other dir) see the same providers.
// Idempotent: a no-op once the store holds any provider. Requires FSUtil + CatalogStore in context.
export const seedFromDirectory = (globalConfigDir: string, directory: string) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore.Service
    const providersSeeded = !(yield* store.isEmpty())
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

    // Global config first (general), then the target directory (specific — wins on conflicts), matching
    // the per-location resolution order in config.ts.
    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir, directory])
      for (const name of NAMES) {
        const info = yield* loadInfo(path.join(dir, name))
        if (info) infos.push(info)
      }
    // NOVACLAW_CONFIG_CONTENT is a first-class config source (the SDK's server launcher passes app
    // config exclusively through it, and headless/test embeddings rely on it). Without importing it
    // here, such an instance boots with an EMPTY catalog and every V2 turn fails model resolution.
    // Appended last = most specific (mirrors the V1 loader treating it as a "local" source).
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) infos.push(inline)
    if (infos.length === 0) return

    // Provider layers import only ONCE (idempotence gate) — a user's later store edits must win.
    if (!providersSeeded) {
      const layers: Record<string, ConfigProvider.Info[]> = {}
      for (const info of infos)
        for (const [id, item] of Object.entries(info.providers ?? {})) (layers[id] ??= []).push(item)
      for (const [id, providerLayers] of Object.entries(layers))
        yield* store.setLayers(ProviderV2.ID.make(id), providerLayers)
    }

    // The default-model import must NOT hide behind the providers gate: an instance whose store
    // was seeded before the config gained a `model` would otherwise freeze default-less forever —
    // model resolution then silently falls back to the FIRST catalog entry. setDefaultIfEmpty
    // still protects an explicit user-set default from being clobbered.
    let defaultModel: string | undefined
    for (const info of infos) if (info.model !== undefined) defaultModel = info.model
    if (defaultModel !== undefined) yield* store.setDefaultIfEmpty(defaultModel)
  })
