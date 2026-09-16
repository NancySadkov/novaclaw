export * as Model from "./model"

import { Schema } from "effect"
import { optional, statics } from "./schema"
import { Provider } from "./provider"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
}).annotate({ identifier: "Model.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

/**
 * How a model is written in config and in a URL: `providerID/id`.
 *
 * 🔴 The id itself MAY contain slashes (`dgx-spark/openai/gpt-oss-120b`), so this splits on the FIRST
 * one only, and refuses a ref with nothing on either side of it. Two hand-written copies of exactly this
 * existed — one in the app, one in the runner — differing only in whether the key was called `id` or
 * `modelID`, which meant neither could be handed to the other's consumers. The key is `id`, because that
 * is what `Model.Ref` above calls it.
 */
export const parseRef = (value: string | undefined): { providerID: string; id: string } | undefined => {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

/** The inverse of {@link parseRef}. */
export const formatRef = (input: { readonly providerID: string; readonly id: string }): string =>
  `${input.providerID}/${input.id}`

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

// The safe default for a hand-added model whose catalogue entry has not declared limits yet.
// Nova supports 32K+ models, but an unknown model starts at the roomier product default; keeping
// the unknown case at zero made context packing inert and,
// more seriously, omitted max_tokens on OpenAI-compatible requests. Slow reasoning models then
// inherited the server's arbitrary generation default and could occupy a device for minutes.
export const DEFAULT_LIMIT = { context: 65_536, output: 16_384 } as const

// How many images we assume an endpoint takes in ONE request when nothing says otherwise.
//
// ONE, deliberately. A model that accepts more loses only speed under this floor; a model that
// accepts fewer than we assumed 400s the request, and the recovery elides images that may never have
// been described — measured 2026-08-20 on holo3.1, whose vLLM caps `--limit-mm-per-prompt` at 3.
// The asymmetry is the whole argument: guess low and it degrades, guess high and it dead-ends.
//
// Raise it per model with `limit.images` (ConfigV2.Model.Limit), which is the operator's statement
// and outranks this. Hosted vision endpoints generally take many; declare it there rather than
// lifting this floor.
export const DEFAULT_IMAGE_LIMIT = 1

/**
 * What a model is FOR — the one rating a person can hold in their head.
 *
 * 🔴 Owner ruling, 2026-09-16: this REPLACES the raw Terminal-Bench 4.0 percentage. A benchmark
 * number is a value no normal user has a way to know (AGENTS.md principle 12), and it had leaked into
 * three independent ladders — selection, role-fit warnings and harness scaffold intensity — each of
 * which could pick a different answer. One three-word rating is the whole vocabulary now:
 *
 *  - `smart` — knowledge-heavy work: writing, design, analysis.
 *  - `usual` — coding, running your OS and sites. THE DEFAULT: an unrated model is this.
 *  - `fast`  — labeling and searching; the cheapest model that can do the job.
 *
 * Capability is a floor (fast < usual < smart), and the single conversion lives in
 * `core/src/model-taxonomy.ts` so selection, fit warnings and scaffold cannot invent different ranks.
 */
export const Taxonomy = Schema.Literals(["smart", "usual", "fast"])
export type Taxonomy = typeof Taxonomy.Type

/** What an unrated model reads as. `usual` is the mainstream job, not the weakest one. */
export const DEFAULT_TAXONOMY: Taxonomy = "usual"

export const PrefixCache = Schema.Struct({
  enabled: Schema.Boolean,
  /** Human-authored minutes; absent uses the conservative five-minute default. */
  ttlMinutes: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
}).annotate({ identifier: "Model.PrefixCache" })
export type PrefixCache = typeof PrefixCache.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
}).annotate({ identifier: "Model.Cost" })

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...Provider.AISDK.fields,
  }),
  Schema.Struct({
    id: ID,
    ...Provider.Native.fields,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Model.Api" })
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  taxonomy: Taxonomy.pipe(optional),
  prefixCache: PrefixCache.pipe(optional),
  // Optional user-authored per-model PRE-PROMPT (owner ruling, 2026-07-29): a correction
  // for THIS model's known behaviour, prepended to the system context for every session that
  // resolves to it. It rides here — beside `taxonomy`, which the property mirrors — because the defect
  // being corrected belongs to the weights, so it travels with the model, not the agent. Absent =
  // inert (the composition rides the runner's `.filter(non-empty)`, so undefined changes nothing).
  prePrompt: Schema.String.pipe(optional),
  /** Per-model connection recovery policy. Attempts includes the original request. */
  retry: Schema.Struct({
    attempts: Schema.Int,
  }).pipe(optional),
  name: Schema.String,
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...Provider.Request.fields,
    variant: Schema.String.pipe(optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...Provider.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
    /** Images accepted in ONE request; absent = unlimited. See ConfigV2.Model.Limit.images. */
    images: Schema.Int.pipe(optional),
  }),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          api: { id: modelID, type: "native", settings: {} },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          retry: { attempts: 3 },
          limit: { ...DEFAULT_LIMIT },
        }),
    })),
  )
