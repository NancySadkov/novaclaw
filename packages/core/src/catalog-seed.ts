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
import { Log } from "@novaclaw/schema/log"

const NAMES = ["config.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

// Models-primary: a model's endpoint URL HOST is its internal
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
// global config dir's `novaclaw.jsonc` and writes them into the instance-wide
// `CatalogStore`, so the catalog no longer depends on reading jsonc per-location at runtime. Runs once at
// server startup (see the server's catalog-seed startup layer) — BEFORE any location boots, which is what
// lets the shared scratch dir (and every other dir) see the same providers.
// Idempotent: a no-op once the store holds any provider. Requires FSUtil + CatalogStore in context.
export const seedFromDirectory = (globalConfigDir: string) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore.Service
    const providersSeeded = !(yield* store.isEmpty())
    const fs = yield* FSUtil.Service

    /**
     * ⚠️ Decoding is ALL-OR-NOTHING per document, and that is the whole reason this reports.
     * `decodeUnknownOption` with `errors: "all"` yields `none` for any single bad field, so one
     * malformed provider entry costs the user every provider, agent and command in that file. It
     * used to do that in silence, and the loss surfaced later as "every turn fails model
     * resolution" — a symptom that names the wrong subsystem entirely. Returning the REASON lets the
     * caller say which file and why; it does not change what is seeded.
     */
    const decodeText = (text: string | undefined): { info?: Config.Info; notice?: string } => {
      if (!text) return {}
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length)
        return { notice: `not valid JSON (${errors.length} parse error${errors.length === 1 ? "" : "s"})` }
      // P2: models-primary flat `models` → nested `providers` before decode (no-op without `models`).
      const decoded = Option.getOrUndefined(decodeInfo(expandFlatModels(input)))
      return decoded ? { info: decoded } : { notice: "did not match the config schema" }
    }

    const loadInfo = (filepath: string) =>
      Effect.gen(function* () {
        const result = decodeText(yield* fs.readFileStringSafe(filepath))
        if (result.notice)
          yield* Log.event("config.catalog.seed.dropped", {
            "config.path": filepath,
            "config.notice": result.notice,
          })
        return result.info
      })

    // The config dir's documents in NAMES order (general first, specific last), matching
    // the per-location resolution order in config.ts.
    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir])
      for (const name of NAMES) {
        const info = yield* loadInfo(path.join(dir, name))
        if (info) infos.push(info)
      }
    // NOVACLAW_CONFIG_CONTENT is an inline config source: without importing it here, an instance
    // configured that way boots with an EMPTY catalog and every V2 turn fails model resolution.
    // Appended last = most specific (mirrors the V1 loader treating it as a "local" source).
    //
    // 🔴 **CORRECTED 2026-09-04. This used to justify itself with "the SDK's server launcher passes
    // app config exclusively through it", and that launcher no longer exists** — `sdk/js/src/v2/
    // server.ts` and its `process.ts` helper were deleted on 2026-07-29 (the SDK's own
    // `zero-runtime-dependencies.test.ts` records why), and launching an instance became the
    // harness's job. Swept the tree: **nothing in the shipped product sets this variable.** Its only
    // live writers are tests (`cli/providers-login.test.ts`, `cli/run/run-process.test.ts`) and the
    // V1 reader in `novaclaw/src/config/config.ts`.
    //
    // ⚠️ That does not make the arm dead — a headless embedder can still set it, and the tests that
    // do are real users of the path. What it makes false is the REASON, and a comment that names a
    // deleted consumer as the load-bearing one sends the next person to defend a requirement nobody
    // has. Ruling 2: a fault is never described falsely, and neither is a justification.
    const inlineResult = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inlineResult.notice)
      yield* Log.event("config.catalog.seed.dropped", {
        "config.path": "NOVACLAW_CONFIG_CONTENT",
        "config.notice": inlineResult.notice,
      })
    if (inlineResult.info) infos.push(inlineResult.info)
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


/**
 * 🔴 **Which config documents in the config dir cannot be read, RIGHT NOW.**
 *
 * The health surface needs this and it must not be a remembered event. Decoding is all-or-nothing
 * per document, so one malformed provider entry costs every provider, agent and command in that
 * file — and the loss reached nobody: a log line, readable only in Developer mode by someone who
 * knew the event name, met much later as *"every turn fails model resolution"*.
 *
 * ⚠️ **It re-reads rather than recalling, and that is what makes it correct.** A drop recorded at
 * seed time goes stale the moment the user fixes the file, and a health screen confidently reporting
 * a repaired problem is worse than one that says nothing. This also covers the case a persisted
 * notice would MISS entirely: a file that was fine at first boot and was broken afterwards.
 *
 * ⚠️ Uses the SAME decode this module seeds with. A second reader would be a second answer to
 * "is this file valid", and the two would drift.
 */
export const unreadableDocuments = (globalConfigDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const out: { path: string; notice: string }[] = []
    for (const name of NAMES) {
      const filepath = path.join(globalConfigDir, name)
      const text = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) continue
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) {
        out.push({
          path: filepath,
          notice: `not valid JSON (${errors.length} parse error${errors.length === 1 ? "" : "s"})`,
        })
        continue
      }
      if (Option.getOrUndefined(decodeInfo(expandFlatModels(input))) === undefined)
        out.push({ path: filepath, notice: "did not match the config schema" })
    }
    return out as readonly { readonly path: string; readonly notice: string }[]
  })
