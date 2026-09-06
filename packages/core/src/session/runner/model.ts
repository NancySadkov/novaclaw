export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { splitModelSampling } from "./sampling-split"
import { withRepetitionFloor } from "./repetition-floor"
import { ModelHealth } from "./model-health"
import { type Model } from "@novaclaw/llm"
import * as AnthropicMessages from "@novaclaw/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@novaclaw/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@novaclaw/llm/route"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Log } from "@novaclaw/schema/log"
import { Catalog } from "../../catalog"
import { Config } from "../../config"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { LocalModelManager } from "../../local-model-manager"
import { ModelV2 } from "../../model"
import { SettingsConfigStore } from "../../settings-config-store"
import { PluginV2 } from "../../plugin"
import { ProbeWindow } from "../../probe-window"
import { ProviderCapability } from "../../provider-capability"
import { ProviderCapabilityStore } from "../../provider-capability-store"
import { ProviderV2 } from "../../provider"
import { DeviceRegistry } from "../device-registry"
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

/**
 * No default model, for a caller that has NO session to blame.
 *
 * Distinct from `ModelNotSelectedError`, which carries a `sessionID`: inventing one here to reuse
 * that error would put a fabricated session id into diagnostics.
 */
export class NoDefaultModelError extends Schema.TaggedErrorClass<NoDefaultModelError>()(
  "SessionRunnerModel.NoDefaultModelError",
  { reason: Schema.String },
) {
  override get message() {
    return `This instance has no default model, so work without a session cannot pick one: ${this.reason}`
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

/**
 * The turn's own input carries an attachment the resolved model cannot read (v0.2.0 prep §10).
 *
 * A PRE-TURN failure by design: it is raised before any request is built, so the user is told the
 * true thing — a model-selection mistake — instead of the provider's 400 about an unsupported media
 * type (ruling 2, *a fault is never described falsely*). `message` is written as a COMPLETE
 * user-facing sentence because `runner/llm.ts`'s `surfacePreTurnFailure` renders it verbatim, and
 * it names both repairs: pick a capable model, or fix this model's declared modalities — the
 * catalog is runtime-editable, so a wrong models.dev entry is repairable from inside the OS
 * (AGENTS.md → *one working model can repair the system*).
 */
export class ModelInputUnsupportedError extends Schema.TaggedErrorClass<ModelInputUnsupportedError>()(
  "SessionRunnerModel.ModelInputUnsupportedError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    /** The models.dev input modality that was refused ("image", "audio", …) — never a MIME type. */
    modality: Schema.String,
    /** The attachment names (or MIME types, when unnamed) that triggered the refusal. */
    files: Schema.Array(Schema.String),
  },
) {
  override get message() {
    const names = this.files.length > 0 ? ` (${this.files.join(", ")})` : ""
    return `\`${this.providerID}/${this.modelID}\` can't read ${this.modality} input, so the ${this.files.length === 1 ? "attachment" : "attachments"}${names} on this message could not be sent. Pick a model that accepts ${this.modality}, or correct this model's input modalities in Settings → Models`
  }
}

export class ImageBatchTooLargeError extends Schema.TaggedErrorClass<ImageBatchTooLargeError>()(
  "SessionRunnerModel.ImageBatchTooLargeError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    count: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message() {
    return `\`${this.providerID}/${this.modelID}\` accepts at most ${this.limit} images in one request, but this message has ${this.count}. Send a smaller batch; earlier images remain available in the chat.`
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

export class DevicePinError extends Schema.TaggedErrorClass<DevicePinError>()("SessionRunnerModel.DevicePinError", {
  deviceID: Schema.NonEmptyString,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  reason: Schema.Literals(["unknown", "incompatible"]),
}) {
  override get message() {
    const problem =
      this.reason === "unknown"
        ? `device \`${this.deviceID}\` is no longer available`
        : `device \`${this.deviceID}\` cannot serve \`${this.providerID}/${this.modelID}\``
    return `This chat could not start because ${problem}. Remove its Device pin to use automatic placement`
  }
}

export type Error =
  | ModelNotSelectedError
  | NoDefaultModelError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | ModelInputUnsupportedError
  | ImageBatchTooLargeError
  | DevicePinError
  | LocalModelManager.UnavailableError
  | Integration.AuthorizationError

export interface Interface {
  /**
   * @param requested — the user NAMED this model (a `--model` flag, a switch, a per-turn override),
   *   as opposed to it arriving from the colleague's own configuration. It decides what an
   *   unavailable model means: an explicit request that cannot be served is an ERROR the caller must
   *   see, while a colleague's configured model being down falls back so the officer keeps working.
   */
  readonly resolve: (
    session: SessionSchema.Info,
    options?: { readonly requested?: boolean },
  ) => Effect.Effect<Model, Error>
  /** Resolve the provider route and the scheduler identity from one placement decision. */
  readonly resolveWithDevice: (
    session: SessionSchema.Info,
    options?: { readonly requested?: boolean },
  ) => Effect.Effect<Resolution, Error>
  /**
   * Report WHICH process served a live turn, so a verdict measured on another is discarded.
   *
   * The case a URL cannot see: a server restarted or reloaded behind the same address. Best-effort
   * and infallible by construction — it runs while a response streams, and no capability record is
   * worth failing a turn for.
   */
  readonly observeServing: (
    model: { readonly providerID: string; readonly id: string },
    servedBy: string,
  ) => Effect.Effect<void>
  /**
   * The instance's DEFAULT model, resolved without a session.
   *
   * For work that has no conversation behind it — document ingestion is the case this exists for.
   * It is not a new resolution path: it is `select()`'s `session.model === undefined` branch, which
   * already resolves `catalog.model.default()`, given an entry point that does not demand a session.
   *
   * ⛔ The alternative — fabricating a `SessionSchema.Info` to satisfy the signature — was rejected:
   * eight required fields would have to be invented, and the made-up `id` surfaces in
   * `ModelNotSelectedError({ sessionID })` and in logs, i.e. a fake session id in diagnostics.
   * `maintenance.ts` spreads a REAL session; that is not the same thing as inventing one.
   */
  readonly resolveDefault: () => Effect.Effect<Model, Error>
  /**
   * 🔴 **The six accessors below all describe the model `resolve` LANDS ON, fallbacks applied — and
   * a per-turn caller should not be reaching for them at all.** They each cost their own resolution,
   * so six of them is six chances to disagree about which model a turn is about; the turn's own
   * `resolveWithDevice` hands back that model once, as `Resolution.ran`, and `perTurnFacts` reads
   * every one of these off it. These stay for callers that hold nothing but a session — and for a
   * seam, where there is no catalog entry to read.
   */
  /** Models item (c): the resolved catalog model's capability tier, for the system-prompt scaffold.
   *  Best-effort — an unresolvable model yields `undefined` rather than failing the turn. */
  readonly tier: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Tier | undefined>
  /** The resolved catalog model's optional user-authored pre-prompt (owner 2026-07-29). Read the
   *  same best-effort way as `tier`: it only decorates the system prompt, so an unresolvable model
   *  yields `undefined` rather than failing the turn. */
  readonly prePrompt: (session: SessionSchema.Info) => Effect.Effect<string | undefined>
  /** Per-model total connection attempts. Undefined selects the runner's safe default. */
  readonly retryAttempts: (session: SessionSchema.Info) => Effect.Effect<number | undefined>
  /**
   * The resolved catalog model's declared capabilities, for the runner's attachment gate. Read the
   * same best-effort way as `tier`/`prePrompt`: an unresolvable model yields `undefined` rather
   * than failing the turn.
   *
   * ⚠️ `undefined` means NO EVIDENCE, never "text-only" — see `to-llm-message.ts`
   * `attachmentSupport`. Collapsing the two would refuse every image on every hand-added local
   * endpoint (which is most of them, and all of ours).
   */
  readonly capabilities: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Capabilities | undefined>
  /**
   * How many images the resolved model accepts in ONE request, or `undefined` for unlimited.
   *
   * Read the same best-effort way as `tier`/`prePrompt`/`capabilities`, and `undefined` is the
   * pass-everything answer, which is what every endpoint that never had this cap wants. See
   * `budgetImages` for why a guessed default would be wrong.
   */
  readonly imageLimit: (session: SessionSchema.Info) => Effect.Effect<number | undefined>
  /**
   * The per-request image cap a PREVIOUS process learned from this endpoint's own refusal.
   *
   * 🔴 The in-process map is why a cold run still loses images: its whole first turn runs with the
   * cap unknown, so `read`'s withholding gate cannot fire. A long-lived server learns once and is
   * fine; a fresh CLI process never was (measured 2026-08-20).
   *
   * ⚠️ Ranked BELOW a declared catalog limit, which is the operator's statement rather than a
   * measurement, and below this process's own map, which is newer.
   */
  readonly learnedImageLimit: (model: ModelV2.Ref) => Effect.Effect<number | undefined>
  /** Remember a cap learned this run. Best-effort: a failed write must never fail a recovered turn. */
  readonly rememberImageLimit: (model: ModelV2.Ref, limit: number) => Effect.Effect<void>
  /** Catalog identity of the model `resolve` lands on — fallbacks included. Unlike the wire route's
   * `model.id`, this is the stable user-facing id and is therefore the identity model-routing config
   * matches, and the identity `ModelHealth` files a verdict under. */
  readonly ref: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Ref | undefined>
  /**
   * The SCHEDULER's device key for the model this session would resolve to (`deviceKeyFor` below).
   * Best-effort like `tier`/`ref` — an unresolvable model yields `undefined` and the runner keeps
   * its own fallback, because a scheduling key must never be able to fail a turn.
   */
  readonly device: (session: SessionSchema.Info) => Effect.Effect<ScheduledDevice | undefined>
}

export interface ScheduledDevice extends DeviceRegistry.SchedulingProfile {
  readonly key: string
}

/**
 * ONE turn's model decision: the wire route, the scheduler identity, and the catalog entry both were
 * built from.
 *
 * 🔴 **`ran` is the whole point, and it is the model that ACTUALLY RAN.** `resolve` owns two
 * fallbacks — an unavailable configured model, and a model `ModelHealth` says is failing — and both
 * used to reassign a LOCAL nothing downstream could see. So a caller that wanted the turn's
 * capabilities, tier, pre-prompt, retry policy or image cap had to ask `select()` again, which
 * applies neither fallback, and got the model the session SELECTED while the request went to the
 * substitute. A screenshot then passed a vision-capable gate on its way into a text-only request —
 * the provider media-type 400 the gate exists to prevent — and the mirror case silently told a
 * sighted model it had not been shown the picture it was holding. Read the per-turn facts off THIS
 * value (`perTurnFacts`) and the two answers collapse into one.
 *
 * ⚠️ `undefined` only on a seam (`layerWith`), which resolves a route with no catalog behind it. A
 * reader that gets `undefined` has no catalog answer at all and must say so, never substitute a
 * second resolution.
 */
export interface Resolution {
  readonly model: Model
  readonly device: ScheduledDevice
  readonly ran: ModelV2.Info | undefined
}

/**
 * Every per-turn fact that describes ONE catalog model, read off that model and nothing else.
 *
 * Exists so the runner cannot derive six of them from six independent lookups again: the failure was
 * never a wrong field, it was six chances to disagree about which model the turn is about.
 */
export const perTurnFacts = (
  model: ModelV2.Info,
): {
  readonly ref: ModelV2.Ref
  readonly tier: ModelV2.Tier | undefined
  readonly prePrompt: string | undefined
  readonly retryAttempts: number | undefined
  readonly capabilities: ModelV2.Capabilities | undefined
  readonly imageLimit: number | undefined
} => ({
  /** Catalog identity — the stable user-facing id, NOT the wire `api.id`. */
  ref: { providerID: model.providerID, id: model.id },
  tier: model.tier,
  prePrompt: model.prePrompt,
  retryAttempts: model.retry?.attempts,
  capabilities: model.capabilities,
  /** `undefined` = unlimited, the pass-everything answer. */
  imageLimit: model.limit.images,
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionRunnerModel") {}

/** Test or embedding seam. `tier`/`prePrompt`/`capabilities` default to always-undefined so
 *  existing callers need not supply them — and `undefined` capabilities is the pass-everything
 *  "no evidence" answer, so a seam that omits it never starts refusing attachments. */
/**
 * WHICH model to run when the one that was chosen cannot serve — the two fallback decisions, as pure
 * functions.
 *
 * 🔴 Extracted 2026-08-22 because the branches that use them had **no test at any level** and two
 * bugs shipped through them in one day: a `session.model` guard copied from one arm to the other
 * (which made the health fallback dead for every roster colleague), and a key built from the WIRE id
 * while the lookup used the CATALOG id. Both were invisible to the unit tests around them, because
 * those tested `ModelHealth`'s arithmetic and the runner's recording — never the code that reads
 * them. The service needs a catalog, a capability store, a settings store, an integration registry
 * and a local-model manager to build; the decision needs none of that.
 *
 * ⚠️ `supported` and `sick` are passed IN rather than reached for, so the rule is testable without a
 * clock or a store and cannot silently start consulting something else.
 */
export const usableFallback = <M>(input: {
  readonly fallback: M | undefined
  readonly available: readonly M[]
  readonly supported: (model: M) => boolean
}): M | undefined =>
  input.fallback !== undefined && input.supported(input.fallback)
    ? input.fallback
    : input.available.find(input.supported)

/**
 * The healthiest model to route to when the SELECTED one is failing.
 *
 * ⚠️ Never routes onto a model that is also sick, and never returns the selected model itself — a
 * "fallback" to what is already failing is a log line claiming a recovery that did not happen.
 * `undefined` means stay put and report the real error, which is right when the default is the thing
 * that is down: bouncing between two dead endpoints reports neither honestly.
 */
export const healthyAlternative = <M>(input: {
  readonly selected: M
  readonly fallback: M | undefined
  readonly available: readonly M[]
  readonly supported: (model: M) => boolean
  readonly sick: (model: M) => boolean
  readonly same: (a: M, b: M) => boolean
}): M | undefined => {
  const healthy =
    input.fallback !== undefined && input.supported(input.fallback) && !input.sick(input.fallback)
      ? input.fallback
      : input.available.find((entry) => input.supported(entry) && !input.sick(entry))
  return healthy !== undefined && !input.same(healthy, input.selected) ? healthy : undefined
}

export const layerWith = (
  resolve: Interface["resolve"],
  tier: Interface["tier"] = () => Effect.succeed(undefined),
  prePrompt: Interface["prePrompt"] = () => Effect.succeed(undefined),
  capabilities: Interface["capabilities"] = () => Effect.succeed(undefined),
  ref: Interface["ref"] = () => Effect.succeed(undefined),
  retryAttempts: Interface["retryAttempts"] = () => Effect.succeed(undefined),
  device: Interface["device"] = () => Effect.succeed(undefined),
  // ⚠️ LAST, deliberately. Inserting a parameter mid-list silently rebinds every positional argument
  // after it — a caller passing `tier` second would have been handing it a default-model resolver,
  // and both compile. (`imageLimit` was briefly added mid-list on 2026-08-19 and is now appended
  // below; no caller passes past `resolve` today, so nothing broke, but the rule stands.)
  /** Seams that never do session-free work leave this alone; calling it then says so by name. */
  resolveDefault: Interface["resolveDefault"] = () =>
    Effect.fail(new NoDefaultModelError({ reason: "this SessionRunnerModel seam provides no default resolver" })),
  /** ⚠️ Added LAST for the reason above. A seam with no capability store simply observes nothing. */
  observeServing: Interface["observeServing"] = () => Effect.void,
  /** ⚠️ Added LAST for the reason above. `undefined` = unlimited, the pass-everything answer. */
  imageLimit: Interface["imageLimit"] = () => Effect.succeed(undefined),
  /** ⚠️ Added LAST for the reason above. A seam with no store simply remembers nothing. */
  learnedImageLimit: Interface["learnedImageLimit"] = () => Effect.succeed(undefined),
  rememberImageLimit: Interface["rememberImageLimit"] = () => Effect.void,
) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve,
      // ⚠️ `ran: undefined`, and that is the honest answer rather than a gap. A seam hands back a
      // wire route with NO catalog entry behind it, so there is nothing here that could describe the
      // model that ran; a reader falls back to the members below, which is the only answer this seam
      // has. Fabricating a `ModelV2.Info` from `model.provider`/`model.id` would look like a catalog
      // fact and be a wire id wearing one.
      resolveWithDevice: (session, options) =>
        Effect.all({ model: resolve(session, options), device: device(session) }).pipe(
          Effect.map(({ model, device }) => ({
            model,
            device: device ?? { key: `${model.provider}/${model.id}` },
            ran: undefined,
          })),
        ),
      resolveDefault,
      learnedImageLimit,
      rememberImageLimit,
      tier,
      prePrompt,
      retryAttempts,
      capabilities,
      imageLimit,
      ref,
      device,
      observeServing,
    }),
  )

/**
 * THE SCHEDULER'S NOTION OF A DEVICE — one physical backend, not one model on it.
 *
 * `session/scheduler.ts` keys its admission gate, its `MAX_BATCH` cap and its EEVDF fairness
 * ledger on a `deviceKey`. The runner computed that key as `${provider}/${model}`, which means two
 * models served by ONE vLLM process were two devices with independent batch capacity — a claim
 * about hardware that is simply false, and the failure mode it produces is oversubscription of the
 * exact box the scheduler exists to protect. (`notes/reports/decisions-v0.2.0.md` step 29 / the
 * `devices-phantom` review; AGENTS.md *the organizing metaphor* -> "a device is NOT
 * single-threaded", where a Device is a model BACKEND.)
 *
 * The key is therefore the model's ENDPOINT ORIGIN, normalized, so every model on one server
 * shares one gate, one cap and one fairness ledger. `new URL(...).origin` collapses the trailing
 * slash, the `/v1` path and case, which are the three ways two catalog entries for one server
 * differ in practice.
 *
 * ⚠️ **A model with NO `api.url` deliberately keeps a PER-MODEL key, and that is not a shortcut.**
 * The batch cap exists to stop us oversubscribing a *local* box with finite KV and bandwidth. A
 * hosted API has no such shared local capacity, so collapsing several cloud models onto one key
 * would serialize unrelated background work for nothing. Known endpoint -> shared hardware ->
 * shared device; unknown endpoint -> no hardware of ours to protect -> leave them apart.
 *
 * The `DeviceRegistry` index (`session/device-registry.ts`) regroups
 *     ORIGINS onto a declared device. This is the half `e5c4e4ec6` could not derive: `:8010` and
 *     `:8011` on one host are two origins and one GPU, and no URL says so.
 *
 * ⚠️ **The errors are not symmetric, and every fallback below picks the same side.** Over-sharing
 * a key makes unrelated turns queue behind one another — a throughput loss, visible, undone by
 * deleting a config entry. Under-sharing hands out `MAX_BATCH` twice for capacity that exists once,
 * which oversubscribes real hardware. So a malformed URL, an unregistered origin and an unresolvable
 * model all fall back to the per-model key (over-partition, the *cheap* error).
 *
 * A session pin is resolved separately by `resolveDevicePlacement`. It may select only a catalog
 * model that really routes to the named Device; it never becomes a scheduler key merely because a
 * caller supplied a string. The selected Device's concurrency and locality ride beside this key.
 * Concurrency is an operator
 * declaration, not a measurement: there is still no KV/VRAM accounting anywhere in the tree.
 */
export interface DeviceOverride {
  /** The `DeviceRegistry`'s normalized-origin → device-id index. */
  readonly endpoints?: DeviceRegistry.EndpointMap
}

export const deviceKeyFor = (model: ModelV2.Info, override?: DeviceOverride): string => {
  const url = model.api.url
  if (url !== undefined) {
    const origin = DeviceRegistry.normalizeOrigin(url)
    // A malformed URL is a catalog defect, not a reason to fail a turn. Fall through to the
    // per-model key: it is always safe (it can only over-partition, never over-share).
    if (origin !== undefined) return override?.endpoints?.get(origin) ?? origin
  }
  return `${model.providerID}/${model.id}`
}

export type DevicePlacement =
  | { readonly _tag: "placed"; readonly model: ModelV2.Info; readonly key: string }
  | { readonly _tag: "refused"; readonly reason: "unknown" | "incompatible" }

/**
 * Bind a session pin to a real catalog placement.
 *
 * The stable scheduler identity is always derived from the candidate's endpoint and the registry.
 * A pin therefore chooses among actual placements of the SAME catalog model (same public id and
 * provider-side id); it never mints a capacity namespace. A configured Device with no matching
 * placement is known-but-incompatible, while a string naming neither a configured Device nor any
 * catalog endpoint is unknown.
 */
export const resolveDevicePlacement = (input: {
  readonly selected: ModelV2.Info
  readonly available: readonly ModelV2.Info[]
  readonly declared?: string
  readonly declaredKnown?: boolean
  readonly endpoints?: DeviceRegistry.EndpointMap
}): DevicePlacement => {
  if (input.declared === undefined || input.declared === "")
    return { _tag: "placed", model: input.selected, key: deviceKeyFor(input.selected, input) }

  const onDevice = input.available.filter((candidate) => deviceKeyFor(candidate, input) === input.declared)
  const current = onDevice.find(
    (candidate) =>
      candidate.providerID === input.selected.providerID &&
      candidate.id === input.selected.id &&
      candidate.api.id === input.selected.api.id,
  )
  if (current !== undefined) return { _tag: "placed", model: current, key: input.declared }

  const alternate = onDevice.find(
    (candidate) =>
      candidate.id === input.selected.id && candidate.api.id === input.selected.api.id && supported(candidate),
  )
  if (alternate !== undefined) return { _tag: "placed", model: alternate, key: input.declared }

  return {
    _tag: "refused",
    reason: input.declaredKnown === true || onDevice.length > 0 ? "incompatible" : "unknown",
  }
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

/**
 * The per-model tool channel an operator (or a measurement) wrote into `request.body`.
 *
 * ⚠️ Anything other than the two known values is IGNORED rather than passed through, and that is the
 * whole content of this function. A typo must leave the model on its NATIVE channel — the working
 * default — instead of selecting a third behaviour, or reaching the wire as a `toolChannel`
 * parameter a server will reject, which turns a misspelt repair into a dead model.
 */
export const configuredToolChannel = (body: Record<string, unknown>): "native" | "prompted" | undefined => {
  const raw = body["toolChannel"]
  return raw === "prompted" || raw === "native" ? raw : undefined
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  // `thinkingBudget` is a harness-side knob carried in `request.body` (see the config seeder), not
  // a sampling param — pull it out before the split so it never reaches the wire.
  const rawBudget = body.thinkingBudget
  const configuredBudget = typeof rawBudget === "number" ? rawBudget : undefined
  // `toolChannel` is the same kind of knob: a harness-side statement about what this endpoint can
  // do, carried in `request.body` because that is the per-model config surface, and pulled out
  // before the split so it never reaches the wire as a provider parameter.
  //
  // ⚠️ Anything other than the two known values is IGNORED rather than passed through. A typo must
  // leave the model on its native channel — the working default — instead of silently selecting a
  // third behaviour or sending `toolChannel` to a server that will reject the whole request.
  const httpBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "apiKey" && key !== "thinkingBudget" && key !== "toolChannel"),
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
/**
 * How many images ONE request may carry, from every source that could know, in precedence order.
 *
 * The floor is LAST on purpose. Owner ruling 2026-08-20: assume a model takes one image unless
 * something says otherwise, because the two wrong guesses do not cost the same — guessing low costs
 * extra requests, guessing high costs a 400 and then elides images the model may never have
 * described. Any higher in this list and the harness would freeze at 1, unable to learn that an
 * endpoint takes more.
 *
 * @param declared   `limit.images` from the catalog — the OPERATOR's statement, so it wins outright.
 * @param discovered What THIS process learned from the endpoint's own 400 this run.
 * @param persisted  What a PREVIOUS process learned. Older than `discovered`, so it ranks below it.
 */
export const resolveImageLimit = (input: {
  readonly declared?: number | undefined
  readonly discovered?: number | undefined
  readonly persisted?: number | undefined
}): number => input.declared ?? input.discovered ?? input.persisted ?? ModelV2.DEFAULT_IMAGE_LIMIT

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
  /**
   * What the capability probe measured for this endpoint, when anything was.
   *
   * ⚠️ A FALLBACK, never an override: the model's own config still wins (see `withDefaults`). Absent
   * — nothing measured, or a fingerprint that no longer matches — leaves the protocol's native
   * default, which is the behaviour before any of this existed.
   */
  measuredToolChannel?: "native" | "prompted",
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  // 🔴 The precedence the self-healing law asks for, in one line: what an OPERATOR wrote beats what
  // we MEASURED, and both beat the protocol's native default. Reversed, a re-test would silently
  // undo a deliberate decision, and the operator would have no way to make one stick.
  //
  // ⚠️ It rides `.model()`, NOT `route.with()`. Route defaults carry no `compatibility`, so a value
  // put there is spread into the defaults object and then dropped on the floor by `Model.make` —
  // silently, with the config read, the strip and the plumbing all working. The tests below catch
  // it; nothing else does.
  const modelInput = (id: ModelV2.ID) => {
    const toolChannel = configuredToolChannel(resolved.request.body) ?? measuredToolChannel
    return toolChannel === undefined ? { id } : { id, compatibility: { toolChannel } }
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model(modelInput(resolved.api.id)),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model(modelInput(resolved.api.id)),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    // Unattended-safety floor: local/compatible models loop without a repetition penalty, so
    // default it to 1.05 here (openai-compatible only — OpenAI/Anthropic reject the key). See
    // repetition-floor.ts. Overridable by the model's own config.
    return Effect.succeed(
      withDefaults(withRepetitionFloor(resolved), OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model(modelInput(resolved.api.id)),
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

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  measuredToolChannel?: "native" | "prompted",
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, credential, measuredToolChannel)),
  )

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

export const ensureManagedModel = (
  manager: LocalModelManager.Interface,
  selected: ModelV2.Info,
  overrides?: Parameters<LocalModelManager.Interface["ensure"]>[1],
) =>
  manager.ensure(
    {
      providerID: selected.providerID,
      modelID: selected.id,
      apiModelID: selected.api.id,
      baseURL: selected.api.url,
      context: selected.limit.context,
    },
    overrides,
  )

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const devices = yield* DeviceRegistry.Service
    const integrations = yield* Integration.Service
    const localModels = yield* LocalModelManager.Service
    const plugins = yield* PluginV2.Service
    const capabilities = yield* ProviderCapabilityStore.Service
    // The same store `ProviderCapabilityStore` sits on. Resolved HERE, in a service layer —
    // never inside the runner's per-request path, which is the shape that abandoned every
    // tool-call turn on 2026-08-06.
    const settings = yield* SettingsConfigStore.Service

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

    /**
     * What the capability probe measured for this model, if anything, and if it still applies.
     *
     * ⚠️ Only `native` and `prompted` are ACTED on. A stored `chat-only` says the endpoint has no
     * usable tool channel at all — a real answer, but not one this seam can express, and forcing
     * `prompted` on it would offer tools we measured as unusable. A stored `unknown` is by
     * definition not a decision. Both fall through to the protocol default, which is what the
     * runner did before any of this existed.
     *
     * ⚠️ Never fails the turn. A store that will not read means no measurement, not a broken model:
     * the cost is a channel chosen the old way, and the alternative is a turn that dies over a
     * question about tool formats.
     */
    const measuredChannel = Effect.fn("SessionRunnerModel.measuredChannel")(function* (model: ModelV2.Info) {
      const url = model.api.url
      if (url === undefined) return undefined
      const entry = yield* capabilities
        .get(
          model.providerID,
          model.id,
          ProviderCapability.fingerprint({
            endpoint: url,
            model: model.api.type === "aisdk" ? model.api.id : model.id,
            protocol:
              model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic"
                ? "anthropic-messages"
                : "openai-chat",
          }),
        )
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return entry?.choice === "native" || entry?.choice === "prompted" ? entry.choice : undefined
    })

    /**
     * ⚠️ `resolve` is WIDER here than on the interface: it hands back the catalog entry beside the
     * route (`Resolution`'s `ran`), and the public member below narrows it to the route. That is
     * deliberate — an in-layer caller (`resolveWithDevice`) must be able to see WHICH model the
     * fallbacks landed on without re-deriving it, and re-deriving it is the entire defect this
     * shape exists to prevent.
     */
    const base: Omit<Interface, "resolveWithDevice" | "resolve"> & {
      readonly resolve: (
        session: SessionSchema.Info,
        options?: { readonly requested?: boolean },
      ) => Effect.Effect<{ readonly model: Model; readonly ran: ModelV2.Info }, Error>
    } = {
      /**
       * A live turn reported WHICH process served it — discard a verdict measured on another.
       *
       * ⚠️ Best-effort and never fails a turn. This runs while a response streams; a store that will
       * not write means the verdict stays and is re-checked next turn, which is the behaviour before
       * this existed. Failing the turn to keep a capability record tidy would be the wrong trade by
       * a wide margin.
       */
      observeServing: Effect.fn("SessionRunnerModel.observeServing")(function* (
        model: { readonly providerID: string; readonly id: string },
        servedBy: string,
      ) {
        yield* capabilities
          .forgetIfMoved(model.providerID, model.id, servedBy)
          .pipe(Effect.catchCause(() => Effect.succeed(false)))
      }),
      /**
       * The route for a turn, AND the catalog entry it was built from.
       *
       * 🔴 It returns the pair because returning only the route is what made seven per-turn facts
       * describe a different model than the one serving the request: `turnModel` below may substitute
       * for an unavailable or a sick model, and a caller that had to ask again got the substitution
       * back out (`Resolution.ran`).
       */
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (
        session: SessionSchema.Info,
        options?: { readonly requested?: boolean },
      ) {
        const selected = yield* turnModel(session, { requested: options?.requested, latch: true, report: true })
        yield* ensureManagedModel(localModels, selected, Config.latest(yield* config.entries(), "local_model_catalog"))
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        const routed = yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
          yield* measuredChannel(selected),
        )
        return { model: routed, ran: selected }
      }),
      /**
       * The instance default, for work with no conversation behind it (document ingestion).
       *
       * ⚠️ Shares `select`, `ensureManagedModel` and the credential lookup with `resolve` above
       * rather than re-deriving them: a second copy of model selection is a second place for the
       * managed-local `ensure` to be forgotten, and forgetting it means a local model is never woken
       * for this path while every symptom points at the model instead.
       *
       * The boot-latch retry is kept for the same reason it exists above — this can run moments
       * after boot, when a location's catalog is still filling.
       */
      resolveDefault: Effect.fn("SessionRunnerModel.resolveDefault")(function* () {
        const sessionless = { model: undefined } as unknown as SessionSchema.Info
        let selected = yield* select(sessionless)
        if (!selected) {
          yield* plugins.ready.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }))
          selected = yield* select(sessionless)
        }
        // No `session.id` to name, and none invented: the caller had no session, so the error says
        // the instance has no usable default rather than blaming a session that never existed.
        if (!selected) return yield* new NoDefaultModelError({ reason: "the catalog offers no supported model" })
        yield* ensureManagedModel(localModels, selected, Config.latest(yield* config.entries(), "local_model_catalog"))
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          sessionless,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
      // Models item (c): best-effort tier lookup for the system-prompt scaffold. Reuses `turnModel`
      // (no boot-latch wait — this only decorates the prompt, never gates the turn) and never fails.
      //
      // ⚠️ `turnModel`, NOT `select`. `select` answers "what did this session CHOOSE", and after a
      // fallback that is not the model the turn runs on — which is how six of these accessors came
      // to describe a model that served nothing.
      tier: Effect.fn("SessionRunnerModel.tier")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.tier
      }),
      // The optional per-model pre-prompt, read the same best-effort way as `tier` — it only
      // decorates the system prompt (never gates the turn), so an unresolvable model → undefined.
      prePrompt: Effect.fn("SessionRunnerModel.prePrompt")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.prePrompt
      }),
      retryAttempts: Effect.fn("SessionRunnerModel.retryAttempts")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.retry?.attempts
      }),
      // The attachment gate's evidence, read exactly like `tier` above — no boot-latch wait, never
      // fails. An unresolved model returns undefined, which the gate reads as "no evidence" and
      // lets through; the turn's real model resolution (`resolve`) is what fails a missing model.
      imageLimit: Effect.fn("SessionRunnerModel.imageLimit")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.limit?.images
      }),
      /**
       * What a PREVIOUS process learned from this endpoint's own 400.
       *
       * ⚠️ Defensive by construction: a malformed row yields `undefined`, not a throw. This value
       * decides whether images are withheld, and a decode failure must degrade to "no cap known"
       * (send everything, exactly as before the store existed) rather than fail a turn.
       */
      learnedImageLimit: Effect.fn("SessionRunnerModel.learnedImageLimit")(function* (model) {
        const all: Record<string, unknown> = yield* settings
          .all()
          .pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))
        const stored = all["provider_media_limit"]
        if (typeof stored !== "object" || stored === null) return undefined
        const value = (stored as Record<string, unknown>)[`${model.providerID}/${model.id}`]
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
      }),
      /** Remember a cap learned this run, merging rather than replacing the other models' rows. */
      rememberImageLimit: Effect.fn("SessionRunnerModel.rememberImageLimit")(function* (model, limit) {
        const all: Record<string, unknown> = yield* settings
          .all()
          .pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))
        const current = all["provider_media_limit"]
        const rows = typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
        yield* settings
          .set("provider_media_limit", { ...rows, [`${model.providerID}/${model.id}`]: limit })
          .pipe(Effect.ignore)
      }),
      capabilities: Effect.fn("SessionRunnerModel.capabilities")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.capabilities
      }),
      ref: Effect.fn("SessionRunnerModel.ref")(function* (session) {
        const model = yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined))
        return model === undefined ? undefined : { providerID: model.providerID, id: model.id }
      }),
      // Read exactly like `ref` above — no boot-latch wait, never fails. A scheduling key that
      // could fail a turn would be a worse defect than the one it fixes.
      //
      // `session.device` here is the CHAIN-RESOLVED declaration, not the raw row: the runner
      // overlays `config.device` onto the session it hands us, exactly as it already overlays
      // `config.model` (`runner/llm.ts`'s `modelSession`). So a sub-agent inherits its parent's
      // device without declaring one, which is what makes this a config field rather than a column.
      device: Effect.fn("SessionRunnerModel.device")(function* (session) {
        const model = yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined))
        if (model === undefined) return undefined
        const endpoints = yield* devices.endpoints()
        const declaredProfile = session.device === undefined ? undefined : yield* devices.profile(session.device)
        const placement = resolveDevicePlacement({
          selected: model,
          available: yield* catalog.model.available(),
          declared: session.device,
          declaredKnown: declaredProfile !== undefined,
          endpoints,
        })
        if (placement._tag === "refused") return undefined
        const profile = placement.key === session.device ? declaredProfile : yield* devices.profile(placement.key)
        return { key: placement.key, ...profile }
      }),
    }

    /**
     * WHICH catalog model a session runs on — `select()` plus BOTH fallbacks, and nothing else.
     *
     * 🔴 **Every reader of a per-turn model fact resolves through HERE, and that is the fix for a
     * whole class of bug rather than one instance of it.** `tier`, `prePrompt`, `retryAttempts`,
     * `capabilities`, `imageLimit`, `ref` and `device` each used to call `select()` directly, which
     * applies NEITHER fallback — so after a health demotion the runner held two models at once and
     * described the sick one while the request went to the substitute. The visible failure was a
     * screenshot passing a *vision* capability gate on its way into a *text-only* request (the
     * provider media-type 400 the gate exists to prevent), and its mirror was worse and silent: a
     * sighted model told, in its own prompt, that it had not been shown the picture it was holding.
     *
     * ⚠️ **Side-effect free on purpose.** Waking a managed local model, resolving credentials and
     * reading the measured tool channel belong to `resolveRoute`; a best-effort prompt decoration
     * must not start a GPU process.
     *
     * @param latch  await the plugin boot latch when the first look finds nothing. The turn's own
     *   resolution does; a prompt decoration does not, because it must never gate a turn on a wait.
     * @param report emit the one `session.model.fallback` line. The turn's resolution owns it — a
     *   line per best-effort reader would report six fallbacks where one happened.
     */
    const turnModel = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      options?: { readonly requested?: boolean; readonly latch?: boolean; readonly report?: boolean },
    ) {
      const report = options?.report === true
      // Location plugins populate and filter the catalog asynchronously during layer startup
      // (plugin-internal's forked boot batch) — a prompt issued right after boot can read an
      // EMPTY catalog and misreport a configured model as unavailable. Only when the first
      // look fails: await the boot latch (bounded — some test graphs never open it) and look
      // again before failing. The healthy path pays nothing.
      let selected = yield* select(session)
      if (!selected && options?.latch === true) {
        yield* plugins.ready.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }))
        selected = yield* select(session)
      }
      // 🔴 FALL BACK to the instance default rather than killing the turn (owner, 2026-08-21: *"if
      // the agent's chosen model is unavailable / gives errors, we temporarily auto switch to the
      // Default model"*).
      //
      // A colleague's model is part of its job description now, so an unavailable one is an
      // ordinary condition — a local model not yet pulled, a provider whose key expired, a machine
      // that used to have a GPU. Refusing the turn made the colleague useless until somebody
      // noticed and edited its configuration; falling back keeps it working, worse, and says so.
      //
      // ⚠️ TEMPORARY means nothing is written. The colleague's configured model is untouched, so
      // the very next turn tries it again and recovers by itself the moment it returns. Rewriting
      // the config on a transient failure would be a silent, permanent downgrade nobody asked for.
      // 🔴 **AN EXPLICIT REQUEST THAT CANNOT BE SERVED IS AN ERROR, NEVER A SUBSTITUTION.**
      // The fallback below exists for a COLLEAGUE whose configured model is temporarily down — the
      // officer keeps working on the default rather than going silent. It must not swallow
      // `--model does/not-exist`: the user named that model, and quietly running a different one is
      // answering a question nobody asked.
      //
      // Measured 2026-08-23 in the release gate: `novaclaw run --model test/nonexistent-model` had
      // started exiting 0, defeating `run-process.test.ts`'s regression guard for #27371. The two
      // rules are both right and the resolver could not tell them apart, because an agent-declared
      // model and a user-requested one arrive on the same field.
      if (!selected && session.model && options?.requested === true)
        return yield* new ModelUnavailableError({
          providerID: session.model.providerID,
          modelID: session.model.id,
        })
      if (!selected && session.model) {
        const usable = usableFallback({
          fallback: yield* catalog.model.default(),
          available: yield* catalog.model.available(),
          supported,
        })
        if (usable) {
          if (report)
            yield* Log.event("session.model.fallback", {
              "session.id": session.id,
              "model.requested": `${session.model.providerID}/${session.model.id}`,
              "model.used": `${usable.providerID}/${usable.id}`,
              "model.reason": "unavailable",
            })
          selected = usable
        } else
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
      }
      // 🔴 The SECOND half of the owner's rule: *"or gives errors"*. A model that resolves cleanly
      // and then fails every request is the commoner fault — a local server that died, a key that
      // expired — and the block above cannot see it, because there is nothing wrong with the
      // catalog entry. `ModelHealth` watches the turns themselves and answers "is this endpoint
      // serving right now"; two exhausted-retry failures inside ten minutes is the bar, so a
      // restarting local server does not demote anybody (see that module's threshold note).
      //
      // ⚠️ Never routes onto a model that is ALSO sick, and never away from the default onto
      // nothing: if the default is the thing failing, staying put and reporting its real error
      // beats bouncing between two dead endpoints and reporting neither.
      // ⚠️ **NO `session.model` GUARD, and it had one until it was driven.** The block above needs
      // `session.model` because it reports what the user ASKED for and there is nothing else to
      // name. This one does not: the question is whether the model this turn is about to use is
      // failing, and where that choice came from is irrelevant.
      //
      // Copying the guard made the feature dead for the case it exists for. A colleague's model
      // comes from its AGENT config, which `select()` applies — it never reaches `config.model`,
      // which resolves from the SESSION ROW (`config-resolve.ts`: `model` → column `model`). So
      // `session.model` is undefined for every roster colleague, and after the composer's per-chat
      // model chip was removed on 2026-08-22 that is very nearly every session. Measured live the
      // same day: holo3.1's endpoint went down, four turns failed with `Transport` in one process,
      // and the fallback never fired once.
      // ⚠️ An EXPLICIT choice is never rerouted (owner, 2026-09-02: *"when the user explicitly picks
      // a specific model, we still present the user with an error asking if they want to switch to
      // another model"*). The self-healing invariant below is about the model nobody chose — a
      // colleague running on the default. Silently moving a user off the model they named is
      // answering a question nobody asked, which is the same rule the availability arm above already
      // states for `--model does/not-exist`.
      if (selected && options?.requested !== true) {
        const at = yield* Clock.currentTimeMillis
        if (ModelHealth.sick(selected, at)) {
          const healthy = healthyAlternative({
            selected,
            fallback: yield* catalog.model.default(),
            available: yield* catalog.model.available(),
            supported,
            sick: (entry) => ModelHealth.sick(entry, at),
            same: (a, b) => `${a.providerID}/${a.id}` === `${b.providerID}/${b.id}`,
          })
          if (healthy) {
            if (report)
              yield* Log.event("session.model.fallback", {
                "session.id": session.id,
                "model.requested": `${selected.providerID}/${selected.id}`,
                "model.used": `${healthy.providerID}/${healthy.id}`,
                "model.reason": "unhealthy",
              })
            selected = healthy
          }
        }
      }
      if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
      return selected
    })

    const resolveWithDevice: Interface["resolveWithDevice"] = Effect.fn("SessionRunnerModel.resolveWithDevice")(
      function* (session, options) {
        // A pin chooses the catalog placement BEFORE we wake a managed model or resolve credentials.
        // Resolving the unpinned route first briefly started the wrong backend and could fail on its
        // unavailable integration even when the pinned placement was healthy. A pin is an explicit
        // placement decision, so it also does not inherit the automatic model-health fallback.
        if (session.device !== undefined && session.device !== "") {
          let selected = yield* select(session)
          if (!selected) {
            yield* plugins.ready.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }))
            selected = yield* select(session)
          }
          const declaredProfile = yield* devices.profile(session.device)
          if (selected === undefined && session.model && options?.requested === true)
            return yield* new ModelUnavailableError({
              providerID: session.model.providerID,
              modelID: session.model.id,
            })
          if (selected === undefined && session.model)
            return yield* new DevicePinError({
              deviceID: session.device,
              providerID: session.model.providerID,
              modelID: session.model.id,
              reason: declaredProfile === undefined ? "unknown" : "incompatible",
            })
          if (selected === undefined) return yield* new ModelNotSelectedError({ sessionID: session.id })

          const placement = resolveDevicePlacement({
            selected,
            available: yield* catalog.model.available(),
            declared: session.device,
            declaredKnown: declaredProfile !== undefined,
            endpoints: yield* devices.endpoints(),
          })
          if (placement._tag === "refused")
            return yield* new DevicePinError({
              deviceID: session.device,
              providerID: selected.providerID,
              modelID: selected.id,
              reason: placement.reason,
            })

          yield* ensureManagedModel(
            localModels,
            placement.model,
            Config.latest(yield* config.entries(), "local_model_catalog"),
          )
          const provider = yield* catalog.provider.get(placement.model.providerID)
          const connection = yield* integrations.connection.active(
            provider?.integrationID ?? Integration.ID.make(placement.model.providerID),
          )
          const routed = yield* resolve(
            session,
            placement.model,
            connection ? yield* integrations.connection.resolve(connection) : undefined,
            yield* measuredChannel(placement.model),
          )
          // A pin resolves its own placement, so the catalog entry the route was built from is
          // `placement.model` — which may be a DIFFERENT placement of the same catalog model than
          // the one `select` returned, and is therefore the one the per-turn facts must describe.
          return { model: routed, device: { key: placement.key, ...declaredProfile }, ran: placement.model }
        }

        // Automatic placement retains the existing fallback/health selection and then derives the
        // scheduler identity from the model that selection produced.
        //
        // ⚠️ The catalog entry now comes back FROM the resolution instead of being re-found in
        // `available` by matching the wire route against `providerID`/`api.id`. That match could
        // miss — a route whose pair names no catalog row fell through to the per-model device key —
        // and a miss is exactly when a caller has no catalog answer to describe the turn with.
        const resolved = yield* base.resolve(session, options)
        const placement = resolveDevicePlacement({
          selected: resolved.ran,
          available: yield* catalog.model.available(),
          endpoints: yield* devices.endpoints(),
        })
        // With no declaration this branch is exhaustive by construction.
        if (placement._tag === "refused")
          return { ...resolved, device: { key: `${resolved.model.provider}/${resolved.model.id}` } }
        const profile = yield* devices.profile(placement.key)
        return { ...resolved, device: { key: placement.key, ...profile } }
      },
    )

    return Service.of({
      ...base,
      // The public member is the route alone. `ran` is not withheld — `resolveWithDevice` is where a
      // caller asks "which model is this turn", and it answers with both halves at once.
      resolve: (session, options) => base.resolve(session, options).pipe(Effect.map((resolved) => resolved.model)),
      resolveWithDevice,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [
    Catalog.node,
    Config.node,
    DeviceRegistry.node,
    Integration.node,
    LocalModelManager.node,
    PluginV2.node,
    // What the capability probe measured. A global node, so this adds a reference rather than a
    // per-location subsystem.
    ProviderCapabilityStore.node,
    SettingsConfigStore.node,
  ],
})
