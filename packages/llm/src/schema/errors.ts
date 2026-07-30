import { Schema } from "effect"
import { ModelID, ProviderID, ProviderMetadata, RouteID } from "./ids"

export const ProviderFailureClassification = Schema.Literal("context-overflow")
export type ProviderFailureClassification = typeof ProviderFailureClassification.Type

export class HttpRequestDetails extends Schema.Class<HttpRequestDetails>("LLM.HttpRequestDetails")({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpResponseDetails extends Schema.Class<HttpResponseDetails>("LLM.HttpResponseDetails")({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpRateLimitDetails extends Schema.Class<HttpRateLimitDetails>("LLM.HttpRateLimitDetails")({
  retryAfterMs: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  remaining: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reset: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class HttpContext extends Schema.Class<HttpContext>("LLM.HttpContext")({
  request: HttpRequestDetails,
  response: Schema.optional(HttpResponseDetails),
  body: Schema.optional(Schema.String),
  bodyTruncated: Schema.optional(Schema.Boolean),
  requestId: Schema.optional(Schema.String),
  rateLimit: Schema.optional(HttpRateLimitDetails),
}) {}

export class InvalidRequestReason extends Schema.Class<InvalidRequestReason>("LLM.Error.InvalidRequest")({
  _tag: Schema.tag("InvalidRequest"),
  message: Schema.String,
  parameter: Schema.optional(Schema.String),
  classification: Schema.optional(ProviderFailureClassification),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class NoRouteReason extends Schema.Class<NoRouteReason>("LLM.Error.NoRoute")({
  _tag: Schema.tag("NoRoute"),
  route: RouteID,
  provider: ProviderID,
  model: ModelID,
}) {
  get retryable() {
    return false
  }

  get message() {
    return `No LLM route for ${this.provider}/${this.model} using ${this.route}`
  }
}

export class AuthenticationReason extends Schema.Class<AuthenticationReason>("LLM.Error.Authentication")({
  _tag: Schema.tag("Authentication"),
  message: Schema.String,
  kind: Schema.Literals(["missing", "invalid", "expired", "insufficient-permissions", "unknown"]),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class RateLimitReason extends Schema.Class<RateLimitReason>("LLM.Error.RateLimit")({
  _tag: Schema.tag("RateLimit"),
  message: Schema.String,
  retryAfterMs: Schema.optional(Schema.Number),
  rateLimit: Schema.optional(HttpRateLimitDetails),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return true
  }
}

export class QuotaExceededReason extends Schema.Class<QuotaExceededReason>("LLM.Error.QuotaExceeded")({
  _tag: Schema.tag("QuotaExceeded"),
  message: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class ContentPolicyReason extends Schema.Class<ContentPolicyReason>("LLM.Error.ContentPolicy")({
  _tag: Schema.tag("ContentPolicy"),
  message: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class ProviderInternalReason extends Schema.Class<ProviderInternalReason>("LLM.Error.ProviderInternal")({
  _tag: Schema.tag("ProviderInternal"),
  message: Schema.String,
  status: Schema.Number,
  retryAfterMs: Schema.optional(Schema.Number),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return true
  }
}

export class TransportReason extends Schema.Class<TransportReason>("LLM.Error.Transport")({
  _tag: Schema.tag("Transport"),
  message: Schema.String,
  kind: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

/**
 * The marker a LOCAL egress policy attaches to the `cause` of the `HttpClientError` it raises when
 * it refuses a request outright, so the decision travels as a TYPE rather than as prose.
 *
 * ⚠️ **The producer is `packages/core/src/offline.ts`, which this package cannot import** (core
 * depends on llm, not the reverse), and the platform's `HttpClientError` reason union is fixed —
 * an offline block therefore has to arrive as one of the platform's own reasons. It arrives as
 * `InvalidUrlError`, which the platform ALSO raises for a genuinely malformed URL
 * (`HttpClient.ts`'s `UrlParams.makeUrl` failure). Those two are different faults: one is a
 * deliberate configuration decision, the other a broken endpoint URL. Discriminating them by tag
 * alone would describe one as the other, so the policy declares itself here instead.
 *
 * Recognised STRUCTURALLY, by `_tag` string, on purpose: core and llm can be bundled separately
 * (the Electron sidecar, the browser build), and an `instanceof` across two copies of the class
 * would silently fail — the exact failure mode that would make an offline block look like an
 * outage again, only intermittently.
 */
export const EGRESS_BLOCKED_TAG = "LLM.EgressBlocked"

export class EgressBlocked {
  readonly _tag = EGRESS_BLOCKED_TAG
  constructor(
    /** The host the policy refused. Always known: a policy cannot block what it cannot resolve. */
    readonly host: string,
    /** The policy's own explanation, including how to allow the host. */
    readonly reason: string,
  ) {}
  toString() {
    return `${EGRESS_BLOCKED_TAG}(${this.host}): ${this.reason}`
  }
}

export function isEgressBlocked(value: unknown): value is EgressBlocked {
  return typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === EGRESS_BLOCKED_TAG
}

/**
 * A request this instance REFUSED to make — offline/airgap mode blocked the host.
 *
 * ⚠️ **Filed apart from `TransportReason` because they are not the same fault** (v0.2.0 ruling 2 —
 * *a fault is never described falsely*). A dead endpoint is an outage: transient, worth a retry,
 * and honestly described as "can't reach the model server". An egress block is a **decision the
 * user's own instance made**: permanent until the configuration changes, never worth a retry, and
 * describing it as unreachability sends a user hunting a network problem that does not exist —
 * while `provider-retry.ts` had to special-case `kind === "InvalidUrlError"` to stop the runner
 * retrying a verdict three times, and the display layer had to parse the executor's prose back
 * apart to recover what the type had thrown away.
 */
export class OfflineBlockedReason extends Schema.Class<OfflineBlockedReason>("LLM.Error.OfflineBlocked")({
  _tag: Schema.tag("OfflineBlocked"),
  message: Schema.String,
  /** The refused host, as the policy resolved it. */
  host: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class InvalidProviderOutputReason extends Schema.Class<InvalidProviderOutputReason>(
  "LLM.Error.InvalidProviderOutput",
)({
  _tag: Schema.tag("InvalidProviderOutput"),
  message: Schema.String,
  route: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.String),
  providerMetadata: Schema.optional(ProviderMetadata),
}) {
  get retryable() {
    return false
  }
}

export class UnknownProviderReason extends Schema.Class<UnknownProviderReason>("LLM.Error.UnknownProvider")({
  _tag: Schema.tag("UnknownProvider"),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export const LLMErrorReason = Schema.Union([
  InvalidRequestReason,
  NoRouteReason,
  AuthenticationReason,
  RateLimitReason,
  QuotaExceededReason,
  ContentPolicyReason,
  ProviderInternalReason,
  TransportReason,
  OfflineBlockedReason,
  InvalidProviderOutputReason,
  UnknownProviderReason,
]).pipe(Schema.toTaggedUnion("_tag"))
export type LLMErrorReason = Schema.Schema.Type<typeof LLMErrorReason>

export class LLMError extends Schema.TaggedErrorClass<LLMError>()("LLM.Error", {
  module: Schema.String,
  method: Schema.String,
  reason: LLMErrorReason,
}) {
  override readonly cause = this.reason

  get retryable() {
    return this.reason.retryable
  }

  get retryAfterMs() {
    return "retryAfterMs" in this.reason ? this.reason.retryAfterMs : undefined
  }

  override get message() {
    return `${this.module}.${this.method}: ${this.reason.message}`
  }
}

/**
 * Failure type for tool execute handlers. Handlers must map their internal
 * errors to this shape; the runtime catches `ToolFailure`s and surfaces them
 * as `tool-error` events plus a `tool-result` of `type: "error"` so the model
 * can self-correct.
 *
 * Anything thrown or yielded by a handler that is not a `ToolFailure` is
 * treated as a defect and fails the stream.
 */
export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("LLM.ToolFailure", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}
