export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { splitModelSampling } from "./sampling-split"
import { withRepetitionFloor } from "./repetition-floor"
import { ModelHealth } from "./model-health"
import { ProviderRecovery } from "./provider-recovery"
import { type Model } from "@novaclaw/llm"
import * as AnthropicMessages from "@novaclaw/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@novaclaw/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@novaclaw/llm/route"
import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Log } from "@novaclaw/schema/log"
import { Catalog } from "../../catalog"
import { CatalogStore } from "../../catalog-store"
import { Config } from "../../config"
import { ConfigProvider } from "../../config/provider"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { LocalModelManager } from "../../local-model-manager"
import { ModelV2 } from "../../model"
import { ModelTaxonomy } from "../../model-taxonomy"
import { SettingsConfigStore } from "../../settings-config-store"
import { PluginV2 } from "../../plugin"
import { ProbeWindow } from "../../probe-window"
import { ProviderCapability } from "../../provider-capability"
import { ProviderCapabilityStore } from "../../provider-capability-store"
import { ProviderV2 } from "../../provider"
import { DeviceRegistry } from "../device-registry"
import { SessionScheduler } from "../scheduler"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
    /**
     * Why the catalog offered nothing, when the catalog was not empty.
     *
     * Optional so the ordinary "there is no model at all" case is unchanged; present when automatic
     * selection was refused by the rating itself (every runnable model rated `Special`). See
     * `noRoutableModelReason`.
     */
    reason: Schema.String.pipe(Schema.optional),
  },
) {
  override get message() {
    const cause = this.reason === undefined ? "" : `: ${this.reason}`
    return `No model is available for session ${this.sessionID}${cause}`
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

export interface ResolveOptions {
  readonly requested?: boolean
  /**
   * The class of model this turn wants, from the colleague's own role (`needsTaxonomy`).
   *
   * Absent = no declaration, then `leastLoaded` keeps its ordinary default-first behaviour. When set
   * it is a FLOOR, never a veto (`ModelTaxonomy.requestModel`): if nothing clears it the officer
   * still runs, and `AgentModelFit` explains the shortfall in the chat. `special` is not expressible
   * here by construction — see `ModelV2.Requirement`.
   */
  readonly taxonomy?: ModelV2.Requirement
  /** Hard protocol needs for this turn. Unknown is never invented: catalog capabilities are exact. */
  readonly requiredCapabilities?: { readonly tools?: boolean }
  /** Exact visibility around the durable provider-backoff sleep; absent callers keep it silent. */
  readonly recoveryWait?: {
    readonly started: (delayMs: number) => Effect.Effect<void>
    readonly ended: () => Effect.Effect<void>
  }
}

export interface Interface {
  /**
   * @param requested — the user NAMED this model (a `--model` flag, a switch, a per-turn override),
   *   as opposed to it arriving from the colleague's own configuration. It decides what an
   *   unavailable model means: an explicit request that cannot be served is an ERROR the caller must
   *   see, while a colleague's configured model being down falls back so the officer keeps working.
   */
  readonly resolve: (session: SessionSchema.Info, options?: ResolveOptions) => Effect.Effect<Model, Error>
  /** Resolve the provider route and the scheduler identity from one placement decision. */
  readonly resolveWithDevice: (
    session: SessionSchema.Info,
    options?: ResolveOptions,
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
  /** Persist a failed route's reconnect deadline across fresh session workers; true when durable. */
  readonly providerFailed: (model: ModelV2.Ref, at: number) => Effect.Effect<boolean>
  /** Zero for a normal route; positive means this request is a single recovery probe. */
  readonly providerRecoveryFailures: (model: ModelV2.Ref) => Effect.Effect<number>
  /** A successful reconnect clears that route's backoff counter. */
  readonly providerSucceeded: (model: ModelV2.Ref) => Effect.Effect<void>
  /**
   * Last gate before a provider request. Reads the instance-wide model switch from SQLite rather
   * than trusting this worker's catalog snapshot, and reloads that snapshot when it is stale.
   * False means the caller must re-resolve the turn; it must not contact this model.
   */
  readonly dispatchAllowed: (model: ModelV2.Ref) => Effect.Effect<boolean>
  /** Run an outbound attempt only while its model remains enabled in the shared source of truth. */
  readonly guardDispatch: <A, E, R>(
    model: ModelV2.Ref,
    attempt: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ModelUnavailableError, R>
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
  /**
   * Models item (c): the resolved catalog model's capability class, for the system-prompt scaffold
   * and the recall budget. Best-effort — an unresolvable model yields `undefined` rather than
   * failing the turn.
   */
  readonly taxonomy: (session: SessionSchema.Info) => Effect.Effect<ModelV2.Taxonomy | undefined>
  /** The resolved catalog model's optional user-authored pre-prompt (owner 2026-07-29). Read the
   *  same best-effort way as `taxonomy`: it only decorates the system prompt, so an unresolvable
   *  model yields `undefined` rather than failing the turn. */
  readonly prePrompt: (session: SessionSchema.Info) => Effect.Effect<string | undefined>
  /** Per-model total connection attempts. Undefined selects the runner's safe default. */
  readonly retryAttempts: (session: SessionSchema.Info) => Effect.Effect<number | undefined>
  /**
   * The resolved catalog model's declared capabilities, for the runner's attachment gate. Read the
   * same best-effort way as `taxonomy`/`prePrompt`: an unresolvable model yields `undefined` rather
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
   * Read the same best-effort way as `taxonomy`/`prePrompt`/`capabilities`, and `undefined` is the
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
   * Best-effort like `taxonomy`/`ref` — an unresolvable model yields `undefined` and the runner keeps
   * its own fallback, because a scheduling key must never be able to fail a turn.
   */
  readonly device: (session: SessionSchema.Info) => Effect.Effect<ScheduledDevice | undefined>
}

export interface ScheduledDevice extends DeviceRegistry.SchedulingProfile {
  readonly key: string
}

/** A reusable last-mile switch check for helpers that may issue more than one provider request. */
export type DispatchGuard = <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ModelUnavailableError, R>

/** Bind the persisted switch gate to the exact catalog row a resolved route came from. */
export const dispatchGuard = (
  models: Pick<Interface, "guardDispatch">,
  model: Pick<ModelV2.Info, "providerID" | "id"> | ModelV2.Ref | undefined,
): DispatchGuard =>
  model === undefined
    ? (attempt) => attempt
    : (attempt) => models.guardDispatch({ providerID: model.providerID, id: model.id }, attempt)

/**
 * ONE turn's model decision: the wire route, the scheduler identity, and the catalog entry both were
 * built from.
 *
 * 🔴 **`ran` is the whole point, and it is the model that ACTUALLY RAN.** `resolve` owns two
 * fallbacks — an unavailable configured model, and a model `ModelHealth` says is failing — and both
 * used to reassign a LOCAL nothing downstream could see. So a caller that wanted the turn's
 * capabilities, class, pre-prompt, retry policy or image cap had to ask `select()` again, which
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
  /**
   * Present exactly when the turn ran on a SUBSTITUTE for the model the session asked for.
   *
   * 🔴 Owner, 2026-09-15: *"we only use substitute model for the one in agent's settings if the
   * picked model is unavailable (timeouts)"*. A substitution is a real fact about the turn — the
   * officer's own model did not answer it — so it travels back with the resolution instead of living
   * only in a `Log.event` line an operator may never read. `runner/llm.ts` turns it into a visible
   * notice; `reason` is what lets that notice send the user to the right repair (a Settings switch
   * versus a dead endpoint).
   */
  readonly substituted?: Substitution
}

/** Why a turn moved off its assigned model, and which model it was. */
export interface Substitution {
  readonly requested: ModelV2.Ref
  readonly reason: "disabled" | "unavailable" | "unhealthy"
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
  readonly taxonomy: ModelV2.Taxonomy
  readonly prePrompt: string | undefined
  readonly retryAttempts: number | undefined
  readonly capabilities: ModelV2.Capabilities | undefined
  readonly imageLimit: number | undefined
} => ({
  /** Catalog identity — the stable user-facing id, NOT the wire `api.id`. */
  ref: { providerID: model.providerID, id: model.id },
  /** Materialised: an unclassified model reads as `usual`, never `undefined` (`ModelTaxonomy.of`).
   *  A model classified `special` is UNRANKED and reports so — see `taxonomyOf`/`ModelTaxonomy.rankOf`. */
  taxonomy: ModelTaxonomy.of(model),
  prePrompt: model.prePrompt,
  retryAttempts: model.retry?.attempts,
  capabilities: model.capabilities,
  /** `undefined` = unlimited, the pass-everything answer. */
  imageLimit: model.limit.images,
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionRunnerModel") {}

/** Test or embedding seam. `taxonomy`/`prePrompt`/`capabilities` default to always-undefined so
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
 * The effective Settings switch for one stored model after its config layers are merged.
 *
 * `undefined` means the CatalogStore has no opinion: bundled/plugin catalogs may legitimately own
 * the model. Once a stored layer names it, absence of `disabled` means enabled and the last explicit
 * `disabled` value wins, matching `config/plugin/provider.ts`'s ordered transform.
 */
export const storedModelEnabled = (
  providers: Record<string, readonly ConfigProvider.Info[]>,
  model: ModelV2.Ref,
): boolean | undefined => {
  let seen = false
  let enabled = true
  for (const layer of providers[model.providerID] ?? []) {
    const configured = layer.models?.[model.id]
    if (configured === undefined) continue
    seen = true
    if (configured.disabled !== undefined) enabled = !configured.disabled
  }
  return seen ? enabled : undefined
}

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

/**
 * Rank a candidate pool by how CLOSE its declared capabilities are to the model being replaced —
 * `invariants.md`: *"if several available pick the one with closest matching capability"*.
 *
 * `preferred` (the instance default, when it is one of the candidates) breaks a TIE only. It cannot
 * win a comparison it is not closest in, which is the whole change: the fallback used to be
 * default-first, so an officer whose local model went down landed on whatever the release calendar
 * made the default rather than on the model that could do the same job.
 *
 * ⚠️ The order is total (`ref` last), so the answer is stable across catalog orderings rather than
 * depending on which `available()` snapshot happened to arrive.
 */
export const rankByCapability = (
  required: ModelV2.Capabilities | undefined,
  candidates: readonly ModelV2.Info[],
  preferred?: ModelV2.Ref | undefined,
): ModelV2.Info[] =>
  candidates
    .map((model) => ({
      model,
      distance: ProviderRecovery.capabilityDistance(required, model.capabilities),
      preferred:
        preferred !== undefined && model.providerID === preferred.providerID && model.id === preferred.id ? 1 : 0,
    }))
    .toSorted(
      (left, right) =>
        left.distance - right.distance ||
        right.preferred - left.preferred ||
        `${left.model.providerID}/${left.model.id}`.localeCompare(`${right.model.providerID}/${right.model.id}`),
    )
    .map((entry) => entry.model)

/**
 * The sentence a user and the officer read when a turn ran on a substitute.
 *
 * 🔴 Owner, 2026-09-15: the substitution must be SURFACED, not silently done. "Switched off" and
 * "could not be reached" are different repairs — the first is a switch only the owner may flip
 * (AGENTS.md: an instance's models are the operator's to enable), the second resolves itself on the
 * reconnect cadence — so the wording never collapses them. Pure and exported so the wording is
 * unit-testable without a runner.
 */
export const substitutionNotice = (input: {
  readonly assigned: string
  readonly ran: string
  readonly reason: Substitution["reason"]
}): string =>
  input.reason === "disabled"
    ? `This turn ran on \`${input.ran}\`. Your assigned model \`${input.assigned}\` is switched off under Settings → Models, so it cannot serve until you re-enable it there — no one else may.`
    : `This turn ran on \`${input.ran}\`. Your assigned model \`${input.assigned}\` could not be reached, so the harness is retrying it in the background and will return to it when it answers.`

export const layerWith = (
  resolve: Interface["resolve"],
  taxonomy: Interface["taxonomy"] = () => Effect.succeed(undefined),
  prePrompt: Interface["prePrompt"] = () => Effect.succeed(undefined),
  capabilities: Interface["capabilities"] = () => Effect.succeed(undefined),
  ref: Interface["ref"] = () => Effect.succeed(undefined),
  retryAttempts: Interface["retryAttempts"] = () => Effect.succeed(undefined),
  device: Interface["device"] = () => Effect.succeed(undefined),
  // ⚠️ LAST, deliberately. Inserting a parameter mid-list silently rebinds every positional argument
  // after it — a caller passing `taxonomy` second would have been handing it a default-model resolver,
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
  /** ⚠️ Added LAST. Test seams without the shared recovery store remain inert. */
  providerFailed: Interface["providerFailed"] = () => Effect.succeed(false),
  providerSucceeded: Interface["providerSucceeded"] = () => Effect.void,
  providerRecoveryFailures: Interface["providerRecoveryFailures"] = () => Effect.succeed(0),
  /** ⚠️ Added LAST. A seam with no CatalogStore permits its synthetic route. */
  dispatchAllowed: Interface["dispatchAllowed"] = () => Effect.succeed(true),
  /** ⚠️ Added LAST. Synthetic seams have no persisted switch to consult. */
  guardDispatch: Interface["guardDispatch"] = (_model, attempt) => attempt,
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
      taxonomy,
      prePrompt,
      retryAttempts,
      capabilities,
      imageLimit,
      ref,
      device,
      observeServing,
      providerFailed,
      providerSucceeded,
      providerRecoveryFailures,
      dispatchAllowed,
      guardDispatch,
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

export const configuredReasoningContent = (body: Record<string, unknown>): "optional" | "required" | undefined => {
  const raw = body["reasoningContent"]
  return raw === "optional" || raw === "required" ? raw : undefined
}

const requiresReasoningContent = (url: string | undefined): boolean => {
  if (url === undefined) return false
  try {
    return new URL(url).hostname.toLowerCase() === "api.deepseek.com"
  } catch {
    return false
  }
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
    Object.entries(body).filter(
      ([key]) => key !== "apiKey" && key !== "thinkingBudget" && key !== "toolChannel" && key !== "reasoningContent",
    ),
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
    // DeepSeek's official thinking-mode endpoint requires the field on EVERY replayed assistant
    // message while tools are present, including turns that generated zero reasoning tokens. Keep
    // the fact runtime-editable for compatible proxies: an explicit model setting wins either way.
    const reasoningContent =
      configuredReasoningContent(resolved.request.body) ??
      (requiresReasoningContent(resolved.api.url) ? "required" : undefined)
    return toolChannel === undefined && reasoningContent === undefined
      ? { id }
      : {
          id,
          compatibility: {
            ...(toolChannel === undefined ? {} : { toolChannel }),
            ...(reasoningContent === undefined ? {} : { reasoningContent }),
          },
        }
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

export const leastLoaded = (input: {
  readonly available: readonly ModelV2.Info[]
  readonly preferred?: ModelV2.Info
  /** The class the caller asked for (`ResolveOptions.taxonomy`); absent asks nothing. */
  readonly taxonomy?: ModelV2.Requirement
  readonly tools?: boolean
  readonly endpoints?: DeviceRegistry.EndpointMap
  readonly devices: readonly SessionScheduler.DeviceSnapshot[]
}): ModelV2.Info | undefined => {
  // 🔴 `special` is filtered out FIRST, and the position is the point: it must not be reachable even
  // through the `adequate.length > 0 ? adequate : capable` fallback below, which exists so an
  // undersized officer still runs. An UNRANKED model is not an undersized one; routing to it is the
  // one thing the classification forbids.
  const capable = input.available.filter(
    (model) =>
      ModelTaxonomy.autoSelectable(model) &&
      supported(model) &&
      (input.tools === undefined || model.capabilities.tools === input.tools),
  )
  // 🔴 The ONE place a class becomes a candidate pool (`ModelTaxonomy.requestModel`). Adequate models
  // win when they exist; otherwise the officer keeps working on everything capable and the in-chat fit
  // notice (`AgentModelFit`) explains the shortfall. A class is guidance, never a veto — an install
  // with one undersized model must still answer.
  const adequate = ModelTaxonomy.requestModel({ taxonomy: input.taxonomy, available: capable })
  const candidates = adequate.length > 0 ? adequate : capable
  const snapshots = new Map(input.devices.map((snapshot) => [snapshot.deviceKey, snapshot]))
  const load = (model: ModelV2.Info) => {
    const snapshot = snapshots.get(deviceKeyFor(model, input))
    if (snapshot === undefined) return { ratio: 0, work: 0 }
    const work =
      snapshot.inFlightInteractive.length +
      snapshot.inFlightBatch.length +
      snapshot.inFlightMaintenance.length +
      snapshot.waiting.length
    return { ratio: work / Math.max(1, snapshot.concurrency), work }
  }
  return candidates.toSorted((left, right) => {
    const a = load(left)
    const b = load(right)
    if (a.ratio !== b.ratio) return a.ratio - b.ratio
    if (a.work !== b.work) return a.work - b.work
    // Class fit breaks ties so an exact match is chosen over an over-provisioned one, and load
    // balancing still decides between two models of the same fit. `fitOf` is how the rank is read
    // off a model; `capable` above already excluded the unranked ones, so no comparison here can see
    // one — `-Infinity` exists only so the sort stays total.
    if (input.taxonomy !== undefined) {
      const leftFit = ModelTaxonomy.fitOf(left, input.taxonomy)
      const rightFit = ModelTaxonomy.fitOf(right, input.taxonomy)
      if (leftFit !== rightFit) return rightFit - leftFit
    }
    const leftPreferred = left.providerID === input.preferred?.providerID && left.id === input.preferred.id
    const rightPreferred = right.providerID === input.preferred?.providerID && right.id === input.preferred.id
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1
    return `${left.providerID}/${left.id}`.localeCompare(`${right.providerID}/${right.id}`)
  })[0]
}

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
    const catalogStore = yield* CatalogStore.Service
    const config = yield* Config.Service
    const devices = yield* DeviceRegistry.Service
    const scheduler = yield* SessionScheduler.Service
    const integrations = yield* Integration.Service
    const localModels = yield* LocalModelManager.Service
    const plugins = yield* PluginV2.Service
    const capabilities = yield* ProviderCapabilityStore.Service
    // The same store `ProviderCapabilityStore` sits on. Resolved HERE, in a service layer —
    // never inside the runner's per-request path, which is the shape that abandoned every
    // tool-call turn on 2026-08-06.
    const settings = yield* SettingsConfigStore.Service

    const selectSnapshot = Effect.fnUntraced(function* (session: SessionSchema.Info, options?: ResolveOptions) {
      const defaultModel = session.model ? undefined : yield* catalog.model.default()
      const available = yield* catalog.model.available()
      // ⚠️ Three arms, and `special` is excluded from two of them. An EXPLICIT choice counts: the
      // session's own model, or the instance default the user set with "Make default". The
      // last-resort arm picks for the user, so it may not land on a model rated "not for agents"
      // (`ModelTaxonomy.autoSelectable`) — see `noRoutableModelReason` for what happens when that
      // leaves nothing.
      return session.model
        ? available.find((model) => model.providerID === session.model?.providerID && model.id === session.model.id)
        : options?.taxonomy !== undefined || options?.requiredCapabilities !== undefined
          ? leastLoaded({
              available,
              preferred: defaultModel,
              taxonomy: options.taxonomy,
              tools: options.requiredCapabilities?.tools,
              endpoints: yield* devices.endpoints(),
              devices: yield* scheduler.snapshot(),
            })
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : available.filter(ModelTaxonomy.autoSelectable).find(supported)
    })

    /**
     * Why the catalog offered nothing to run on, when it did offer models.
     *
     * 🔴 The case the `special` class CREATES: the catalog is not empty, yet automatic selection
     * cannot use any of it. `"No model is available"` over a Models screen full of models is a fault
     * described falsely (ruling 2) — and the repair is one pick in the very screen the sentence
     * names, so the sentence may as well name it. `undefined` when the reason is something else
     * (an empty catalog, or nothing supported at all), which leaves the original message intact.
     */
    const noRoutableModelReason = Effect.fnUntraced(function* () {
      const entries = yield* catalog.model.available()
      if (entries.some((model) => supported(model) && ModelTaxonomy.autoSelectable(model))) return undefined
      const blocked = entries.filter((model) => supported(model) && !ModelTaxonomy.autoSelectable(model))
      if (blocked.length === 0) return undefined
      return (
        `every runnable model is rated Special (${blocked.map((model) => `${model.providerID}/${model.id}`).join(", ")}). ` +
        `Special models are reserved for a colleague that names one explicitly, so nothing is chosen automatically — ` +
        `re-rate one as Usual in Settings → Models`
      )
    })

    /**
     * A session worker is a separate, long-lived process. ConfigStoreWrite's reload callback is
     * intentionally process-local, so the host can update SQLite while this worker still holds the
     * old catalog. Reconcile the exact choice against the shared store before it becomes a route.
     */
    const select = Effect.fnUntraced(function* (session: SessionSchema.Info, options?: ResolveOptions) {
      let selected = yield* selectSnapshot(session, options)
      const stored = yield* catalogStore.providers()
      const storedDefault = session.model === undefined ? yield* catalogStore.getDefault() : undefined
      const parsedDefault = storedDefault === undefined ? undefined : ModelV2.parse(storedDefault)
      const expected = session.model
        ? { providerID: session.model.providerID, id: session.model.id }
        : parsedDefault === undefined
          ? undefined
          : { providerID: parsedDefault.providerID, id: parsedDefault.modelID }
      const loaded = expected === undefined ? undefined : yield* catalog.model.get(expected.providerID, expected.id)
      const switched = expected === undefined ? undefined : storedModelEnabled(stored, expected)
      const selectedRef = selected === undefined ? undefined : `${selected.providerID}/${selected.id}`
      // A disabled configured default is SUPPOSED to resolve to another enabled model; do not
      // reload forever merely because the stored preference and its live fallback differ.
      const defaultChanged =
        session.model === undefined &&
        storedDefault !== undefined &&
        storedDefault !== selectedRef &&
        switched !== false &&
        (switched !== undefined || loaded !== undefined)
      if (defaultChanged || (switched !== undefined && (loaded === undefined || loaded.enabled !== switched))) {
        yield* catalog.reload()
        selected = yield* selectSnapshot(session, options)
      }
      return selected
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
      ) => Effect.Effect<
        { readonly model: Model; readonly ran: ModelV2.Info; readonly substituted?: Substitution },
        Error
      >
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
      providerFailed: Effect.fn("SessionRunnerModel.providerFailed")(function* (model, at) {
        return yield* settings
          .update("provider_recovery", (current) =>
            ProviderRecovery.exhausted(ProviderRecovery.decode(current), model, at),
          )
          .pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
      }),
      providerRecoveryFailures: Effect.fn("SessionRunnerModel.providerRecoveryFailures")(function* (model) {
        return yield* settings.all().pipe(
          Effect.map(
            (config) =>
              ProviderRecovery.decode(config["provider_recovery"])[ProviderRecovery.key(model)]?.failures ?? 0,
          ),
          Effect.catchCause(() => Effect.succeed(0)),
        )
      }),
      providerSucceeded: Effect.fn("SessionRunnerModel.providerSucceeded")(function* (model) {
        yield* settings
          .update("provider_recovery", (current) => ProviderRecovery.succeeded(ProviderRecovery.decode(current), model))
          .pipe(Effect.ignore)
      }),
      dispatchAllowed: Effect.fn("SessionRunnerModel.dispatchAllowed")(function* (model) {
        const stored = storedModelEnabled(yield* catalogStore.providers(), model)
        const loaded = yield* catalog.model.get(model.providerID, model.id)
        if (stored !== undefined && (loaded === undefined || loaded.enabled !== stored)) yield* catalog.reload()
        return (yield* catalog.model.available()).some(
          (entry) => entry.providerID === model.providerID && entry.id === model.id,
        )
      }),
      guardDispatch: (model, attempt) =>
        Effect.gen(function* () {
          if (yield* base.dispatchAllowed(model)) return yield* attempt
          return yield* new ModelUnavailableError({ providerID: model.providerID, modelID: model.id })
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
        options?: ResolveOptions,
      ) {
        const decision = yield* turnDecision(session, {
          requested: options?.requested,
          latch: true,
          report: true,
          recoveryWait: options?.recoveryWait,
        })
        const selected = decision.selected
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
        return {
          model: routed,
          ran: selected,
          ...(decision.substituted === undefined ? {} : { substituted: decision.substituted }),
        }
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
        //
        // ⚠️ `noRoutableModelReason()` first, so the rating case is named rather than folded into
        // "no supported model" — the same false description the session path refuses to give.
        if (!selected)
          return yield* new NoDefaultModelError({
            reason: (yield* noRoutableModelReason()) ?? "the catalog offers no supported model",
          })
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
      // Models item (c): best-effort class lookup for the system-prompt scaffold and recall budget.
      // Reuses `turnModel` (no boot-latch wait — this only decorates the prompt, never gates the
      // turn) and never fails.
      //
      // ⚠️ `turnModel`, NOT `select`. `select` answers "what did this session CHOOSE", and after a
      // fallback that is not the model the turn runs on — which is how six of these accessors came
      // to describe a model that served nothing.
      taxonomy: Effect.fn("SessionRunnerModel.taxonomy")(function* (session) {
        const model = yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined))
        return model === undefined ? undefined : ModelTaxonomy.of(model)
      }),
      // The optional per-model pre-prompt, read the same best-effort way as `taxonomy` — it only
      // decorates the system prompt (never gates the turn), so an unresolvable model → undefined.
      prePrompt: Effect.fn("SessionRunnerModel.prePrompt")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.prePrompt
      }),
      retryAttempts: Effect.fn("SessionRunnerModel.retryAttempts")(function* (session) {
        return (yield* turnModel(session).pipe(Effect.orElseSucceed(() => undefined)))?.retry?.attempts
      }),
      // The attachment gate's evidence, read exactly like `taxonomy` above — no boot-latch wait, never
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
     * whole class of bug rather than one instance of it.** `taxonomy`, `prePrompt`, `retryAttempts`,
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
    const turnDecision = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      options?: ResolveOptions & { readonly latch?: boolean; readonly report?: boolean },
    ) {
      const report = options?.report === true
      /** Set the FIRST time this turn leaves the model the session asked for. See `Substitution`. */
      let substituted: Substitution | undefined
      // Location plugins populate and filter the catalog asynchronously during layer startup
      // (plugin-internal's forked boot batch) — a prompt issued right after boot can read an
      // EMPTY catalog and misreport a configured model as unavailable. Only when the first
      // look fails: await the boot latch (bounded — some test graphs never open it) and look
      // again before failing. The healthy path pays nothing.
      let selected = yield* select(session, options)
      if (!selected && options?.latch === true) {
        yield* plugins.ready.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }))
        selected = yield* select(session, options)
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
      // 🔴 **A PIN TO A MODEL THE USER HAS SWITCHED OFF IS NOT A REQUEST** (owner, 2026-09-12:
      // *"Turning model off should short circuit any traffic to it ASAP, switching agents to
      // available models."*)
      //
      // `session.model` is where an explicit choice lands — but it is ALSO where a chat's INHERITED
      // model was written once and then left behind. Measured on a live instance 2026-09-12: every
      // session, including officer chats whose colleague names no model at all, carried a pin to
      // whichever model was the instance default on the day that chat was created (the composer
      // stamped its RESOLVED model on the first prompt; `submit.ts` no longer does). So the row
      // outranked the officer permanently, and reading it as "the user named this" turned the
      // switch-off itself into a hard failure: the model is disabled in Settings, the row still asks
      // for it, and every turn dies with *"the selected model … is unavailable. Pick an available
      // model in Settings"* — including the turns no composer sends, which is why nothing ever
      // cleared it and only a restart appeared to help.
      //
      // The catalog separates the two cases `requested` conflates, and `enabled` has exactly one
      // writer in the tree — `config/plugin/provider.ts`, `model.enabled = !config.disabled`, i.e.
      // the Settings switch and nothing else:
      //   · present with `enabled === false` → the user SWITCHED IT OFF. That is a state which
      //     changed underneath a snapshot, not an instruction we failed to honour, so the pin is
      //     void and the ordinary fallback below serves the turn.
      //   · absent from the catalog entirely → nothing was ever served under that ref (a typo, a
      //     `--model` for a model this instance does not have). Still the caller's mistake, and the
      //     error below still stands for it — that is `run-process.test.ts`'s guard for #27371.
      if (!selected && session.model) {
        const pinned = yield* catalog.model.get(session.model.providerID, session.model.id)
        const switchedOff = pinned !== undefined && !pinned.enabled
        // An explicit caller may still demand a hard failure for a ref the catalog has never heard
        // of — but never for one the user has deliberately turned off.
        if (options?.requested === true && !switchedOff)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        // The unavailable catalog entry may not be routable, but its declared capabilities still
        // define what the replacement must be able to do.
        //
        // ⚠️ `autoSelectable` excludes `special` from the pool. A substitute is chosen FOR the user,
        // and a model rated "not for agents" may only serve when its own settings name it — being the
        // stand-in for something else is exactly the silent promotion the rating forbids.
        const compatible = (entry: ModelV2.Info) =>
          ModelTaxonomy.autoSelectable(entry) &&
          supported(entry) &&
          ProviderRecovery.capabilitiesMatch(pinned?.capabilities, entry.capabilities)
        // `invariants.md` — *"if several available pick the one with closest matching capability"*.
        // Ranked, not default-first: the tie-break below still prefers the instance default when it
        // is EQUALLY close, but a closer substitute wins outright.
        const ranked = rankByCapability(
          pinned?.capabilities,
          (yield* catalog.model.available()).filter(compatible),
          yield* catalog.model.default(),
        )
        const usable = usableFallback({ fallback: ranked[0], available: ranked, supported: compatible })
        if (usable) {
          if (report)
            yield* Log.event("session.model.fallback", {
              "session.id": session.id,
              "model.requested": `${session.model.providerID}/${session.model.id}`,
              "model.used": `${usable.providerID}/${usable.id}`,
              "model.reason": switchedOff ? "disabled" : "unavailable",
            })
          substituted ??= {
            requested: { providerID: session.model.providerID, id: session.model.id },
            reason: switchedOff ? "disabled" : "unavailable",
          }
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
      // catalog entry. The durable recovery ledger crosses session-worker process boundaries. It
      // routes around a failed endpoint until its next probe window, rather than forgetting every
      // failure when the worker exits.
      //
      // ⚠️ Never routes normal traffic onto a route that is ALSO sick. If none is healthy, the
      // durable deadlines select the earliest compatible recovery probe instead of terminating or
      // bouncing blindly between dead endpoints.
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
      // A model id that never existed is still reported above. A route that existed and then became
      // unavailable is different: work continues on a capability-compatible substitute even when
      // the original turn named that model explicitly, and returns when its reconnect probe succeeds.
      if (selected) {
        const at = yield* Clock.currentTimeMillis
        const recovery = ProviderRecovery.decode((yield* settings.all())["provider_recovery"])
        const selectedRecovery = recovery[ProviderRecovery.key(selected)]
        const unavailable = ProviderRecovery.unavailable(recovery, selected, at)
        // Once a durable row exists it owns recovery timing. The old process-local health hint must
        // not suppress a probe whose durable deadline has arrived.
        const routeSick = (entry: ModelV2.Info) => {
          const row = recovery[ProviderRecovery.key(entry)]
          return ProviderRecovery.unavailable(recovery, entry, at) || (row === undefined && ModelHealth.sick(entry, at))
        }
        if (routeSick(selected)) {
          const required = selected.capabilities
          const available = yield* catalog.model.available()
          const healthyPool = rankByCapability(
            required,
            available.filter(
              (entry) =>
                ModelTaxonomy.autoSelectable(entry) &&
                supported(entry) &&
                ProviderRecovery.capabilitiesMatch(required, entry.capabilities),
            ),
            yield* catalog.model.default(),
          )
          const healthy = healthyAlternative({
            selected,
            fallback: healthyPool[0],
            available: healthyPool,
            supported: (entry) =>
              ModelTaxonomy.autoSelectable(entry) &&
              supported(entry) &&
              ProviderRecovery.capabilitiesMatch(required, entry.capabilities),
            sick: routeSick,
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
            substituted ??= {
              requested: { providerID: selected.providerID, id: selected.id },
              reason: "unhealthy",
            }
            selected = healthy
          } else if (unavailable) {
            // No healthy substitute is not a terminal state. Wait without occupying a device slot,
            // then probe whichever compatible route becomes eligible first. Repeated failures move
            // that route's durable deadline 2 s, 4 s, 8 s … up to thirty minutes, forever.
            //
            // ⚠️ `selected` is kept whatever its class — an explicitly named model IS the route being
            // recovered, so it must be probeable — while the rest of the pool excludes `special`.
            const compatible = [selected, ...available.filter(ModelTaxonomy.autoSelectable)].filter(
              (entry, index, all) =>
                supported(entry) &&
                ProviderRecovery.capabilitiesMatch(required, entry.capabilities) &&
                all.findIndex((other) => `${other.providerID}/${other.id}` === `${entry.providerID}/${entry.id}`) ===
                  index,
            )
            const probe = ProviderRecovery.earliest(recovery, compatible)
            // `selectedRecovery` makes this branch reachable only with at least the selected row;
            // retain an explicit error for malformed state rather than spinning with no deadline.
            if (probe === undefined || selectedRecovery === undefined)
              return yield* new ModelUnavailableError({ providerID: selected.providerID, modelID: selected.id })
            const delayMs = Math.max(0, probe.next - at)
            yield* options?.recoveryWait?.started(delayMs) ?? Effect.void
            yield* Effect.sleep(Duration.millis(delayMs)).pipe(
              Effect.ensuring(options?.recoveryWait?.ended() ?? Effect.void),
            )
            selected = probe.model
          }
        }
      }
      if (!selected)
        return yield* new ModelNotSelectedError({ sessionID: session.id, reason: yield* noRoutableModelReason() })
      return { selected, ...(substituted === undefined ? {} : { substituted }) }
    })

    /**
     * The model alone, for the best-effort per-turn fact readers (`taxonomy`, `prePrompt`, …). The turn's
     * own resolution wants `turnDecision` — it also carries WHY a substitute was used, which the
     * transcript notice needs and a decoration must never pay for.
     */
    const turnModel = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      options?: ResolveOptions & { readonly latch?: boolean; readonly report?: boolean },
    ) {
      return (yield* turnDecision(session, options)).selected
    })

    const resolveWithDevice: Interface["resolveWithDevice"] = Effect.fn("SessionRunnerModel.resolveWithDevice")(
      function* (session, options) {
        // A pin chooses the catalog placement BEFORE we wake a managed model or resolve credentials.
        // Resolving the unpinned route first briefly started the wrong backend and could fail on its
        // unavailable integration even when the pinned placement was healthy. A pin is an explicit
        // placement decision, so it also does not inherit the automatic model-health fallback.
        if (session.device !== undefined && session.device !== "") {
          let selected = yield* select(session, options)
          if (!selected) {
            yield* plugins.ready.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }))
            selected = yield* select(session, options)
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
          if (selected === undefined)
            return yield* new ModelNotSelectedError({ sessionID: session.id, reason: yield* noRoutableModelReason() })

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
    CatalogStore.node,
    Config.node,
    DeviceRegistry.node,
    SessionScheduler.node,
    Integration.node,
    LocalModelManager.node,
    PluginV2.node,
    // What the capability probe measured. A global node, so this adds a reference rather than a
    // per-location subsystem.
    ProviderCapabilityStore.node,
    SettingsConfigStore.node,
  ],
})
