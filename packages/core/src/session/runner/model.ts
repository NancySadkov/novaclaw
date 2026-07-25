export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { splitModelSampling } from "./sampling-split"
import { withRepetitionFloor } from "./repetition-floor"
import { type Model } from "@novaclaw/llm"
import * as AnthropicMessages from "@novaclaw/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@novaclaw/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@novaclaw/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { PluginV2 } from "../../plugin"
import { ProbeWindow } from "../../probe-window"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  /** Models item (c): the resolved catalog model's capability tier, for the system-prompt scaffold.
   *  Best-effort — an unresolvable model yields `undefined` rather than failing the turn. */
  readonly tier: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Tier | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionRunnerModel") {}

/** Test or embedding seam. `tier` defaults to always-undefined so existing callers need not supply it. */
export const layerWith = (
  resolve: Interface["resolve"],
  tier: Interface["tier"] = () => Effect.succeed(undefined),
) => Layer.succeed(Service, Service.of({ resolve, tier }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  // `thinkingBudget` is a harness-side knob carried in `request.body` (see the config seeder), not
  // a sampling param — pull it out before the split so it never reaches the wire.
  const rawBudget = body.thinkingBudget
  const configuredBudget = typeof rawBudget === "number" ? rawBudget : undefined
  const httpBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "apiKey" && key !== "thinkingBudget"),
  )
  // Protocol-owned sampling (temperature/top_p/top_k/penalties/…) must go through the
  // canonical `generation` options, not the http.body overlay — the native transport
  // rejects those keys in an overlay. Only provider extras (min_p, repetition_penalty, …)
  // stay in http.body. See sampling-split.ts.
  const split = splitModelSampling(httpBody)
  const context = ProbeWindow.get(model.providerID, model.id) ?? model.limit.context
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    ...(Object.keys(split.generation).length > 0 ? { generation: split.generation } : {}),
    http: { body: split.http },
    // B15/T3 — a live probe's server-reported window (vLLM max_model_len) is the HONORED
    // context size and beats the catalog limit, which lies whenever config drifts from the
    // serving process. Runtime-only override; the catalog value stays the cold-start default.
    limits: {
      context,
      output: model.limit.output,
      // MindControl (notes/experimental.md): default the reasoning budget to context/4 when the
      // config doesn't set one, capped at the output limit so no single reasoning phase asks for
      // more tokens than the server can return. 0 (or a 0-context model) leaves it off.
      thinkingBudget: defaultThinkingBudget(configuredBudget, context, model.limit.output),
    },
  })
}

/** context/4 (capped at the output limit) unless the config pins an explicit per-model value. */
/**
 * The reasoning-token ceiling for a turn.
 *
 * A CONFIGURED value is honoured but still clamped to what the model can physically produce. It used to be
 * returned raw, which made the feature fail silently in both directions: a budget above the output limit can
 * never be reached, so no checkpoint ever fires and the controller is inert — exactly what a fat-fingered
 * `600060006000` does (a real value found in the owner's config, left by the settings append bug). The
 * clamp is to what is reachable, NOT to the default's `context/4`: asking for more thinking than the default
 * is a legitimate choice, asking for more than the model can emit is not.
 */
export const defaultThinkingBudget = (configured: number | undefined, context: number, output: number): number => {
  const reachable = output > 0 ? (context > 0 ? Math.min(output, context) : output) : context
  if (configured !== undefined) {
    const wanted = Math.max(0, Math.floor(configured))
    return reachable > 0 ? Math.min(wanted, reachable) : wanted
  }
  if (context <= 0) return 0
  const quarter = Math.floor(context / 4)
  return output > 0 ? Math.min(quarter, output) : quarter
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    // Unattended-safety floor: local/compatible models loop without a repetition penalty, so
    // default it to 1.05 here (openai-compatible only — OpenAI/Anthropic reject the key). See
    // repetition-floor.ts. Overridable by the model's own config.
    return Effect.succeed(
      withDefaults(withRepetitionFloor(resolved), OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const plugins = yield* PluginV2.Service

    const select = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      const defaultModel = session.model ? undefined : yield* catalog.model.default()
      return session.model
        ? (yield* catalog.model.available()).find(
            (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
          )
        : defaultModel && supported(defaultModel)
          ? defaultModel
          : (yield* catalog.model.available()).find(supported)
    })

    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup
        // (plugin-internal's forked boot batch) — a prompt issued right after boot can read an
        // EMPTY catalog and misreport a configured model as unavailable. Only when the first
        // look fails: await the boot latch (bounded — some test graphs never open it) and look
        // again before failing. The healthy path pays nothing.
        let selected = yield* select(session)
        if (!selected) {
          yield* plugins.ready.pipe(
            Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }),
          )
          selected = yield* select(session)
        }
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
      // Models item (c): best-effort tier lookup for the system-prompt scaffold. Reuses `select`
      // (no boot-latch wait — this only decorates the prompt, never gates the turn) and never fails.
      tier: Effect.fn("SessionRunnerModel.tier")(function* (session) {
        return (yield* select(session).pipe(Effect.orElseSucceed(() => undefined)))?.tier
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, PluginV2.node],
})
