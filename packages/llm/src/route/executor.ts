import { Cause, Context, Effect, Layer } from "effect"
import { readBoundedText } from "@novaclaw/schema/bounded-stream"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  OfflineBlockedReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
  isEgressBlocked,
} from "../schema"
import { classify } from "../provider-error"

export interface Interface {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/LLM/RequestExecutor") {}

const BODY_LIMIT = 16_384
const REDACTED = "<redacted>"

// One source of truth for what counts as a sensitive name across headers,
// URL query keys, and field names embedded inside request/response bodies.
//
// `SENSITIVE_NAME` is used as both a substring matcher (for free-form header
// names like `Authorization` / `X-API-Key`) and as the body-field alternation
// list. `SHORT_QUERY_NAME` covers anchored short keys like `?key=…` / `?sig=…`
// that are too generic to redact substring-style without false positives.
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)

const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (headers: Headers.Headers, redactedNames: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>) => {
  return (
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

const retryableStatus = (status: number) => status === 429 || status === 503 || status === 504 || status === 529

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const requestDetails = (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers, redactedNames),
  })

const responseDetails = (
  response: HttpClientResponse.HttpClientResponse,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpResponseDetails({
    status: response.status,
    headers: redactHeaders(response.headers, redactedNames),
  })

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }

  Object.entries(request.headers).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) add(bearer)
  })

  if (!URL.canParse(request.url)) return values
  new URL(request.url).searchParams.forEach((value, key) => {
    if (isSensitiveQueryName(key)) add(value)
  })
  return values
}

// Two passes: structural (redact `"name": "value"` and `name=value` patterns
// for any field name that looks sensitive) plus literal (replace any actual
// secret values we sent in the request, in case the response echoes one back).
const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

const responseBody = (body: string | void, request: HttpClientRequest.HttpClientRequest, readTruncated = false) => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  // ⚠️ `readTruncated` rides alongside the length check because redaction can make the text LONGER
  // than what was read (`<redacted>` is wider than a short key), so length alone no longer tells you
  // whether the provider had more to say.
  if (redacted.length <= BODY_LIMIT) return readTruncated ? { body: redacted, bodyTruncated: true } : { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

const providerMessage = (status: number, body: { readonly body?: string }) => {
  if (body.body && body.body.length <= 500) return `Provider request failed with HTTP ${status}: ${body.body}`
  return `Provider request failed with HTTP ${status}`
}

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly redactedNames: ReadonlyArray<string | RegExp>
  readonly body: ReturnType<typeof responseBody>
  readonly requestId?: string | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request, input.redactedNames),
    response: responseDetails(input.response, input.redactedNames),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

/**
 * Anchored to a FIELD, not to a bare word. `http.body` is up to 16 KB of whatever the endpoint
 * echoed back, which on llama.cpp and several gateways INCLUDES the offending request — so a bare
 * substring test reads "safety" out of a system prompt, a tool name, or a file the agent had just
 * read, and calls an ordinary refusal a content-policy block.
 */
const CONTENT_POLICY =
  /"(?:code|type|reason|finish_reason)"\s*:\s*"[^"]*(?:content[-_ ]?policy|content[-_ ]?filter|safety)[^"]*"/i

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  ) {
    const classification = classify(body)
    // 🔴 ORDER. The refusal's own CLASSIFICATION wins over a content-policy reading of the same
    // bytes, and the sniff runs INSIDE this arm rather than ahead of every status branch.
    //
    // Sniffed first, a context-overflow 400 whose echoed body merely CONTAINED the word "safety"
    // became a `ContentPolicyReason` — which carries no `classification` field at all, so
    // `isContextOverflowFailure` and the media-limit check both answer falsy and the runner's
    // compaction and image-shedding never fire: the session is permanently unrunnable rather than
    // recovering. Ahead of the other branches it was worse — a 429 whose body echoed the prompt
    // lost `retryAfterMs` and its entire rate-limit path, and 401/403/5xx were reachable the same
    // way. This is the argument `provider-error.ts:classify` already makes for media-before-
    // overflow: the recovery that FITS the fault decides which reading wins.
    if (classification === undefined && CONTENT_POLICY.test(body))
      return new ContentPolicyReason({ message: input.message, http: input.http })
    return new InvalidRequestReason({ message: input.message, classification, http: input.http })
  }
  if (input.status >= 500 || retryableStatus(input.status)) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

const statusError =
  (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status < 400) return response
      /**
       * 🔴 **NC-SEC-006 — the diagnostic body is BOUNDED AS IT ARRIVES.** This was
       * `yield* response.text`, which materialises the whole body before `responseBody` slices it to
       * 16,384 — so the 16 KB "limit" was a display limit, and a configured endpoint could hand back
       * a body of any size and have the host buffer all of it. A provider URL is configuration, not
       * trust: an unreachable-host typo and a hostile endpoint reach this line identically.
       */
      const read = yield* readBoundedText(response.stream, BODY_LIMIT).pipe(
        Effect.catch(() => Effect.succeed({ text: undefined as string | undefined, truncated: false })),
      )
      const body = read.text
      const headers = normalizedHeaders(response.headers)
      const retryAfter = retryAfterMs(headers)
      const rateLimit = rateLimitDetails(headers, retryAfter)
      const details = responseBody(body, request, read.truncated)
      return yield* new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: statusReason({
          status: response.status,
          message: providerMessage(response.status, details),
          retryAfterMs: retryAfter,
          rateLimit,
          http: responseHttp({
            request,
            response,
            redactedNames,
            body: details,
            requestId: requestId(headers),
            rateLimit,
          }),
        }),
      })
    })

const toHttpError =
  (redactedNames: ReadonlyArray<string | RegExp>, outgoing: HttpClientRequest.HttpClientRequest) =>
  (error: unknown) => {
    /**
     * 🔴 **The endpoint is attached HERE, by construction, and not by each arm remembering to.**
     *
     * `session-error.ts` ships two headlines for a transport fault — `session.error.transport`
     * (*"Can't reach the model server."*) and `session.error.transportEndpoint` (*"Can't reach the
     * model server at {{endpoint}}."*) — and the second is translated in all 18 bundles. It is chosen
     * by `endpointOf(message)`, which reads the message and nothing else, because the message is the
     * only field that survives onto the session record (`session/runner/llm.ts` publishes
     * `reason.message`; `reason.url` is dropped).
     *
     * Measured live 2026-08-19 against a dead endpoint: the `TransportError` arm below produced the
     * bare message `HTTP transport failed`, so `endpointOf` found nothing and a user whose model server
     * was down read *"Can't reach the model server"* **without ever being told which one**. Three of
     * the four arms appended `(target …)` by hand; that one had been missed, so the translated,
     * actionable headline was unreachable on the single most likely first failure a lay user hits.
     *
     * That is ruling 2's other half — this module's own header names it: hiding the address is *"the
     * other failure: a fault described uselessly"* — and it is what AGENTS.md's self-healing rule needs,
     * since a user whose provider moved can only repair the URL they are shown. So the suffix is added
     * once, here, where the request is already in hand. Idempotent: an arm that already named a target
     * is left exactly as it wrote it.
     */
    const withTarget = (message: string, request: HttpClientRequest.HttpClientRequest | undefined) => {
      if (request === undefined || /\(target\s/.test(message)) return message
      return `${message} (target ${redactUrl(request.url)})`
    }
    const transportError = (input: {
      readonly message: string
      readonly kind?: string | undefined
      readonly request?: HttpClientRequest.HttpClientRequest | undefined
    }) =>
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new TransportReason({
          message: withTarget(input.message, input.request),
          kind: input.kind,
          url: input.request ? redactUrl(input.request.url) : undefined,
          http: input.request ? new HttpContext({ request: requestDetails(input.request, redactedNames) }) : undefined,
        }),
      })

    if (Cause.isTimeoutError(error)) {
      return transportError({
        message: `${error.message} (target ${redactUrl(outgoing.url)})`,
        kind: "Timeout",
        request: outgoing,
      })
    }
    if (!HttpClientError.isHttpClientError(error)) {
      // Surface the underlying failure instead of a catch-all. The bare
      // "HTTP transport failed" hides the real cause (ECONNREFUSED / ENOTFOUND /
      // TLS / proxy / runtime), which makes transport bugs (esp. cross-runtime,
      // e.g. the Electron sidecar vs bun) far harder to diagnose.
      const detail =
        error instanceof Error
          ? error.message +
            (error.cause !== undefined
              ? ` | cause: ${String((error.cause as { message?: unknown })?.message ?? error.cause)}`
              : "")
          : String(error)
      // Always name the target host:port — the #1 diagnostic lead, so a user (or an
      // online model reading the transcript) can tell a dead/misconfigured endpoint
      // from a real outage without rebuilding the app with extra logging.
      return transportError({
        message: `HTTP transport failed: ${detail} (target ${redactUrl(outgoing.url)})`,
        request: outgoing,
      })
    }
    const request = ("request" in error ? error.request : undefined) ?? outgoing
    // A LOCAL egress policy refused this request — it never left the machine. That is a DECISION,
    // not an outage, so it gets its own reason instead of being flattened into Transport: filing
    // both under one tag made a deliberate airgap block and a dead vLLM box indistinguishable
    // downstream, forced `provider-retry.ts` to special-case a `kind` string to stop retrying a
    // verdict, and forced the display layer to parse this function's own prose back apart. Ruling 2
    // — a fault is never described falsely.
    const blocked = "cause" in error.reason ? error.reason.cause : undefined
    if (isEgressBlocked(blocked)) {
      return new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new OfflineBlockedReason({
          // The policy's own words stay verbatim — they carry the remedy ("add the provider …,
          // extend NOVACLAW_OFFLINE_ALLOW …, or turn offline mode off"), which no i18n key could —
          // and the `(target …)` suffix is what lets a display recover the host for its headline.
          message: `${blocked.reason} (target ${redactUrl(request.url)})`,
          host: blocked.host,
          url: redactUrl(request.url),
          http: new HttpContext({ request: requestDetails(request, redactedNames) }),
        }),
      })
    }
    if (error.reason._tag === "TransportError") {
      return transportError({
        message: error.reason.description ?? "HTTP transport failed",
        kind: error.reason._tag,
        request,
      })
    }
    // Keep the reason's own description when it has one. ⚠️ The offline chokepoint used to be the
    // motivating case and is now handled above by type; what still lands here is the residual
    // `HttpClientError` set (`EncodeError`, `DecodeError`, `EmptyBodyError`, and the platform's own
    // malformed-URL `InvalidUrlError`), where the description is the only accurate text there is.
    // Giving each of those a typed arm is the next step, not this one.
    const described = "description" in error.reason && error.reason.description
    return transportError({
      message: described
        ? `HTTP transport failed: ${error.reason._tag} — ${error.reason.description}`
        : `HTTP transport failed: ${error.reason._tag}`,
      kind: error.reason._tag,
      request,
    })
  }

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const executeOnce = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const redactedNames = yield* Headers.CurrentRedactedNames
        return yield* http
          .execute(request)
          .pipe(
            Effect.mapError(toHttpError(redactedNames, request)),
            Effect.flatMap(statusError(request, redactedNames)),
          )
      })
    return Service.of({
      // One wire request, one classified result. Full-request retry belongs to the session runner,
      // which alone knows whether assistant output or a tool side effect has already made replay
      // ambiguous. Keeping transport retries here multiplied the model's configured attempt budget
      // and hid the real recovery window from both the user and the runner.
      execute: executeOnce,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

export * as RequestExecutor from "./executor"
