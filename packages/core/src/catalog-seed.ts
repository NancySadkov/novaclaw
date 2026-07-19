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

// Models-primary P2 (notes/models-primary-plan.md): a model's endpoint URL HOST is its internal
// provider group. The host carries no "/", so the pervasive `providerID/modelID` addressing stays
// intact, and grouping-by-endpoint aligns with per-endpoint credentials (P5). URL-less or
// malformed → the model is its own singleton provider (id = model id).
export const providerIdForUrl = (url: string | undefined, fallback: string): string => {
  if (!url) return fallback
  try {
    return new URL(url).host || fallback
  } catch {
    return fallback
  }
}

// Expand a raw config's flat top-level `models` map (P1) into the nested `providers` shape the rest
// of the seed already consumes, so the CatalogStore + model resolution stay UNCHANGED — the flip
// lives entirely at this authoring boundary. Operates on RAW parsed JSON (before decode) to avoid
// reconstructing schema classes. Each flat model's `url` becomes its synthesized provider's
// openai-compatible `api`; `tier` rides through onto the nested model (the catalog plugin carries
// it to ModelV2.Info); a bare default-model id is expanded to `providerID/modelID`. Configs without `models` pass
// through untouched (no regression to the nested path). Merges into any hand-authored `providers`.
export const expandFlatModels = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw
  const config = raw as Record<string, unknown>
  const models = config.models
  if (typeof models !== "object" || models === null) return raw
  const providers: Record<string, Record<string, unknown>> = {
    ...(typeof config.providers === "object" && config.providers !== null
      ? (config.providers as Record<string, Record<string, unknown>>)
      : {}),
  }
  for (const [modelId, value] of Object.entries(models as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const { url, ...modelFields } = value as Record<string, unknown>
    const endpoint = typeof url === "string" ? url : undefined
    const providerId = providerIdForUrl(endpoint, modelId)
    const provider = (providers[providerId] = { ...providers[providerId] })
    if (endpoint && provider.api === undefined)
      provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: endpoint }
    provider.models = { ...(provider.models as Record<string, unknown>), [modelId]: modelFields }
  }
  const result: Record<string, unknown> = { ...config, providers }
  delete result.models
  const defaultModel = result.model
  if (typeof defaultModel === "string" && Object.prototype.hasOwnProperty.call(models, defaultModel)) {
    const entry = (models as Record<string, Record<string, unknown>>)[defaultModel]
    const endpoint = typeof entry?.url === "string" ? entry.url : undefined
    result.model = `${providerIdForUrl(endpoint, defaultModel)}/${defaultModel}`
  }
  return result
}

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
      // P2: models-primary flat `models` → nested `providers` before decode (no-op without `models`).
      return Option.getOrUndefined(decodeInfo(expandFlatModels(input)))
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
