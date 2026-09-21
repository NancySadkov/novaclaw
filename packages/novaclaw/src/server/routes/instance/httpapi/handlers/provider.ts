import { Config } from "@/config/config"
import { ConfigProviderConnection } from "@novaclaw/core/config/provider-connection"
import { EndpointURL } from "@novaclaw/core/config/endpoint-url"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { ProbeWindow } from "@novaclaw/core/probe-window"
import { ProviderCatalogResult } from "@/provider/catalog-result"
import { Catalog } from "@novaclaw/core/catalog"
import { ModelV2 } from "@novaclaw/core/model"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { InstanceState } from "@/effect/instance-state"

import { Duration, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { isEgressBlocked } from "@novaclaw/llm"
import { InstanceHttpApi } from "../api"
import type { ProbePayload } from "../groups/provider"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { ProviderCapability } from "@novaclaw/core/provider-capability"
import { ProviderCapabilityStore } from "@novaclaw/core/provider-capability-store"
import { ProviderSession } from "@novaclaw/core/session/runner/provider-session"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ProviderV2 } from "@novaclaw/core/provider"

/** How long one probe may take end to end (connect + headers + body). */

/**
 * The airgap verdict's headline, kept SHORT and FIRST so it survives any downstream truncation.
 *
 * ⚠️ It is prose rather than a `status` arm because the wire schema (`groups/provider.ts`'s
 * `ProbeResult`) has no `"blocked"` literal, and adding one is a four-file change this handler does
 * not own (schema + SDK regen + `probeLabel`'s exhaustive switch in `settings-v2/models.tsx` +
 * `dialog-new-model.tsx`'s `statusMessage`). What ruling 2 demands is that a refusal is never
 * *described* as unreachability — so it is filed under `error`, never `unreachable`, and says what
 * it is in the first clause. See the report accompanying this change for the follow-up.
 */
export const AIRGAP_BLOCK_PREFIX = "Blocked by airgap — this request never left your computer."

/**
 * What the probe's ONE network round trip produced. Each failure arm carries the exact `status` the
 * handler puts on the wire, so a test of this function is a test of what the user is told.
 */
export type ProbeTransport =
  | { readonly kind: "ok"; readonly body: unknown }
  /** The instance's own offline policy refused the host — a DECISION, not an outage. */
  | { readonly kind: "blocked"; readonly status: "error"; readonly host: string; readonly detail: string }
  | { readonly kind: "auth"; readonly status: "auth"; readonly detail: string }
  | { readonly kind: "http"; readonly status: "error"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly status: "unreachable"; readonly detail: string }

/** Best text available for a transport failure, without leaking the whole error object. */
function transportDetail(error: unknown): string {
  if (!HttpClientError.isHttpClientError(error)) return String(error)
  const reason = error.reason as { _tag: string; description?: string; cause?: unknown }
  const cause = reason.cause
  const causeText =
    cause instanceof Error
      ? `${cause.message}${cause.cause === undefined ? "" : `: ${String((cause.cause as { message?: unknown })?.message ?? cause.cause)}`}`
      : cause === undefined
        ? undefined
        : String(cause)
  return `${reason._tag}: ${reason.description ?? causeText ?? "no detail"}`
}

/**
 * OFF-A — the probe's single round trip, through the SHARED guarded `HttpClient`.
 *
 * ⚠️ This used to be a raw global `fetch`, which meant *Settings → Models → Custom endpoint → Find
 * models* EGRESSED with airgap mode ON — while `/shell/offline` reported 8/8 layers active and
 * `offline.ts`'s layer-1 manifest named "probe" as one of the callers riding the chokepoint. The
 * payload can carry an API key (the handler below falls back to the saved provider's
 * `request.body.apiKey`), so what escaped was a credential, not just a URL. Design-principle 4 says
 * the data plane never egresses; ruling 2 says a fault is never described falsely. This is the fix
 * that makes the manifest's existing claim TRUE rather than correcting the claim downward.
 *
 * Loopback keeps working with airgap ON, by construction: `Offline.checkUrl` allows loopback
 * unconditionally before it ever consults the allowlist ("the app talking to itself is not egress"),
 * which is what the local-runtime sweep (`core/src/config/local-runtime.ts`) is built on.
 *
 * Never fails — every outcome classifies, exactly as the old `fetch` version did.
 */
export const probeEndpoint = (
  client: HttpClient.HttpClient,
  url: string,
  headers: Record<string, string>,
  /** From `provider_connection.discovery_timeout_ms`; defaulted when a caller has no config. */
  timeoutMs: number = ConfigProviderConnection.DEFAULT_DISCOVERY_TIMEOUT_MS,
): Effect.Effect<ProbeTransport> =>
  client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
    Effect.flatMap((response) => {
      if (response.status === 401 || response.status === 403)
        return Effect.succeed<ProbeTransport>({ kind: "auth", status: "auth", detail: `HTTP ${response.status}` })
      if (response.status < 200 || response.status >= 300)
        return Effect.succeed<ProbeTransport>({ kind: "http", status: "error", detail: `HTTP ${response.status}` })
      return response.json.pipe(
        Effect.map((body): ProbeTransport => ({ kind: "ok", body })),
        Effect.orElseSucceed((): ProbeTransport => ({ kind: "ok", body: undefined })),
      )
    }),
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.succeed<ProbeTransport>({
          kind: "unreachable",
          status: "unreachable",
          // Names the bound in seconds, because the fix is a number the reader can raise.
          detail: `No answer within ${Duration.toSeconds(Duration.millis(timeoutMs))} seconds.`,
        }),
    }),
    Effect.catch((error) => {
      // The offline policy declares itself in the reason's `cause` (see `core/src/offline.ts`), and
      // is recognised STRUCTURALLY by `_tag` — `isEgressBlocked`, the same predicate the LLM
      // RequestExecutor uses to lift a block into `OfflineBlockedReason`. Tag-sniffing the platform's
      // `InvalidUrlError` instead would confuse a deliberate refusal with a genuinely malformed URL.
      const blocked = "cause" in error.reason ? error.reason.cause : undefined
      if (isEgressBlocked(blocked))
        return Effect.succeed<ProbeTransport>({
          kind: "blocked",
          status: "error",
          host: blocked.host,
          // The policy's own words stay verbatim after the headline: they carry the remedy ("add the
          // provider…, extend NOVACLAW_OFFLINE_ALLOW…, or turn offline mode off"), and NOT truncated
          // — this string is ours and bounded, unlike an arbitrary transport error.
          detail: `${AIRGAP_BLOCK_PREFIX} ${blocked.reason}`,
        })
      return Effect.succeed<ProbeTransport>({
        kind: "unreachable",
        status: "unreachable",
        detail: transportDetail(error).slice(0, 300),
      })
    }),
  )

/** One normalized candidate address and what probing it produced. */
export interface DiscoveryAttempt {
  readonly baseURL: string
  readonly transport: ProbeTransport
  readonly discoveryMs: number
}

export type DiscoveryResult =
  | { readonly kind: "invalid"; readonly requestedURL: string }
  | {
      readonly kind: "probed"
      readonly attempts: readonly DiscoveryAttempt[]
      readonly selected: DiscoveryAttempt
    }

/**
 * Normalize the line the user typed, then try each candidate in order and keep the first that
 * answers as a real OpenAI-compatible endpoint.
 *
 * Selection is by EVIDENCE, not by whichever request finished first: a model list proves the route
 * (`modelListCount > 0`), an auth challenge proves it exists and wants credentials, and any other
 * 2xx proves something is there. A deliberate airgap refusal stops the loop, because retrying the
 * next candidate would multiply one policy verdict into a log of blocked requests and bury the one
 * that matters. Extraction from the handler is what makes these rules testable without a socket.
 */
export const probeDiscovery = (
  client: HttpClient.HttpClient,
  input: {
    readonly requestedURL: string
    readonly headers: Record<string, string>
    /** From `provider_connection.discovery_timeout_ms`; defaulted when a caller has no config. */
    readonly timeoutMs?: number
  },
): Effect.Effect<DiscoveryResult> =>
  Effect.gen(function* () {
    const candidates = EndpointURL.candidates(input.requestedURL)
    if (candidates.length === 0) return { kind: "invalid" as const, requestedURL: input.requestedURL }

    const attempts: DiscoveryAttempt[] = []
    for (const candidate of candidates) {
      const started = Date.now()
      const transport = yield* probeEndpoint(client, `${candidate}models`, input.headers, input.timeoutMs)
      attempts.push({ baseURL: candidate, transport, discoveryMs: Date.now() - started })
      // A deliberate refusal is a DECISION, not an outage: retrying the next candidate would
      // multiply one policy verdict into a log of blocked requests and bury the one that matters.
      if (transport.kind === "blocked") break
      // An auth challenge does NOT break: it is weaker evidence than a real model list, so the
      // fallback still gets its chance to answer openly. The selection below ranks a list first.
      if (transport.kind === "ok" && EndpointURL.modelListCount(transport.body) > 0) break
    }

    const selected =
      attempts.find((a) => a.transport.kind === "ok" && EndpointURL.modelListCount(a.transport.body) > 0) ??
      attempts.find((a) => a.transport.kind === "auth") ??
      attempts.find((a) => a.transport.kind === "ok") ??
      attempts.find((a) => a.transport.kind === "blocked") ??
      attempts[0]!
    return { kind: "probed" as const, attempts, selected }
  })

/**
 * CAPABILITY NEGOTIATION — three more bounded requests that answer *what can this endpoint do*.
 *
 * `probeCompletion` below proves a generation comes back. That is not enough to decide how the
 * harness should talk to a model: an endpoint that silently ignores `tools` produces a turn reading
 * as the agent refusing to act, and nothing tells the user that apart from a broken instance.
 *
 * ⚠️ **Opt-in, because it COSTS generation.** Discovery is one GET; this is three completions. The
 * probe payload asks for it explicitly, so opening Settings never spends tokens.
 *
 * ⚠️ **No side effects by construction.** The tool offered is capture-only (`ProviderCapability`):
 * it exists to be called and does nothing when it is. There is no executor here to forget that.
 *
 * ⚠️ **Two wire shapes, chosen by auth style.** Tools live in a different envelope on the Anthropic
 * messages wire, and sending the wrong one would measure our own request rather than the endpoint —
 * so the shape comes from `ProviderCapability.WIRES` and the rung logic is written once above it.
 */

/**
 * How long ONE rung may take, and how much room it is given.
 *
 * ⚠️ Both are READ FROM THE STORE at the point of use, never compiled in. Each is a property of the
 * user's slowest model and their hardware, which we cannot see from here: a 4B thinking model on a
 * laptop's Vulkan build needs 26.8 s for the native rung, and a bigger model on a weaker box needs
 * more than any figure we could pick. When the bound is too small the rung is recorded as unmeasured
 * and the model is durably routed to the prompted channel — a permanent wrong answer, with no error
 * to see. Self-healing law: a value an outage hinges on has to be repairable from inside the OS.
 *
 * A generous timeout is safe because a rung is only ever asked after the chat rung already returned a
 * completion, so the endpoint is known alive; this waits on a slow MODEL, never a dead host.
 */
export interface ProbeLimits {
  readonly timeout: Duration.Duration
  readonly maxTokens: number
}

export const probeLimits = (connection: ConfigProviderConnection.Info | undefined): ProbeLimits => ({
  timeout: Duration.millis(ConfigProviderConnection.capabilityProbeTimeoutMs(connection)),
  maxTokens: ConfigProviderConnection.capabilityProbeMaxTokens(connection),
})

/**
 * Room for a reasoning pass AND the answer.
 *
 * The probe asks for three tiny values, so this is not about the answer's size — it is about what a
 * thinking model spends before it starts. Measured 2026-08-13: at 64 the JSON rung returned nothing
 * at all on Holo3.1.
 */

/**
 * WHICH serving process answered, remembered across the rungs of one negotiation.
 *
 * ⚠️ Module-scoped and reset by `probeCapabilities` before its first request. A negotiation is one
 * sequence of awaited calls from one handler, so its rungs cannot interleave with another's; this is
 * a scratch slot for that sequence, not shared state.
 */
let seenFingerprint: string | undefined

const capabilityAsk = (
  client: HttpClient.HttpClient,
  input: {
    baseURL: string
    path: string
    headers: Record<string, string>
    body: Record<string, unknown>
    timeout: Duration.Duration
  },
): Effect.Effect<ProviderCapability.Response> =>
  client
    .execute(
      HttpClientRequest.post(`${input.baseURL.replace(/\/+$/, "")}/${input.path}`, {
        headers: new Headers({ ...input.headers, "content-type": "application/json" }),
        body: HttpBody.jsonUnsafe(input.body),
      }),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? response.text.pipe(
              Effect.map((body): ProviderCapability.Response => ({ kind: "http", status: response.status, body })),
              Effect.catch(() =>
                Effect.succeed<ProviderCapability.Response>({ kind: "http", status: response.status, body: "" }),
              ),
            )
          : response.json.pipe(
              Effect.map((payload): ProviderCapability.Response => {
                // Every response carries it, so the first rung that answers settles it. Read here
                // rather than by a fourth request: asking again would spend a generation to learn
                // something three responses already said.
                const reported = (payload as { system_fingerprint?: unknown } | null)?.system_fingerprint
                if (typeof reported === "string" && reported.length > 0) seenFingerprint ??= reported
                return { kind: "body", payload }
              }),
              // A success whose body is not JSON is a proxy or a gateway answering for the endpoint.
              // That says nothing about the model, so it must land as a fault, not as a capability.
              Effect.catch(() =>
                Effect.succeed<ProviderCapability.Response>({
                  kind: "http",
                  status: response.status,
                  body: "The endpoint answered 2xx with a body that is not JSON.",
                }),
              ),
            ),
      ),
      Effect.timeoutOrElse({
        duration: input.timeout,
        orElse: () =>
          Effect.succeed<ProviderCapability.Response>({
            kind: "transport",
            // Names the bound that stopped it, because the fix is a setting the reader can change.
            detail: `no answer within ${Duration.toSeconds(input.timeout)}s`,
          }),
      }),
      Effect.catch((error) =>
        Effect.succeed<ProviderCapability.Response>({
          kind: "transport",
          detail: transportDetail(error).slice(0, 200),
        }),
      ),
    )

/**
 * A completion that spent its whole budget saying nothing teaches us about OUR REQUEST, not the
 * endpoint. Checked before every rung's reader so no rung can score it as a capability.
 *
 * The RULE — stopped at the ceiling AND said nothing — is one rule for both wires; only the word for
 * "stopped at the ceiling" differs (`length` on one, `max_tokens` on the other), which is why that
 * word lives in the wire and this does not.
 */
const budgetFault = (wire: ProviderCapability.Wire, payload: unknown): ProviderCapability.Outcome | undefined =>
  wire.exhausted(payload) && wire.text(payload).trim().length === 0
    ? {
        kind: "unknown",
        fault: "budget",
        detail: "The model spent the probe's whole token budget without answering — often a reasoning pass.",
      }
    : undefined

/** An envelope we cannot read is a fault, never "the model cannot do this". */
const malformed = (): ProviderCapability.Outcome => ({
  kind: "unknown",
  fault: "malformed",
  detail: "The response did not match this endpoint's expected response shape.",
})

/** The protocols a probe can speak — the keys of the capability module's wire table. */
export type ProbeWire = keyof typeof ProviderCapability.WIRES

/**
 * Which wire each API channel speaks.
 *
 * ⚠️ A TOTAL record over the closed channel set, not a ternary. The channel is how this handler
 * learns which protocol a model expects, so a channel added later must be given a wire deliberately
 * — with a ternary it would silently inherit the OpenAI-chat envelope and every rung would measure
 * our own wrong request. The exhaustiveness is the guard; the compiler names the omission.
 *
 * ⚠️ `@ai-sdk/openai` is the RESPONSES wire in this tree (`session/runner/model.ts`), which is why
 * the package name and the protocol name disagree: the SDK routes that package to `/responses`, and
 * a model on a gateway that serves only `/responses` is configured with it.
 */
const WIRE_FOR_CHANNEL: Readonly<Record<ConfigProviderPreset.ApiChannel, ProbeWire>> = {
  "@ai-sdk/openai-compatible": "openai-chat",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic-messages",
}

export const probeCapabilities = (
  client: HttpClient.HttpClient,
  input: {
    baseURL: string
    modelID: string
    wire: ProbeWire
    headers: Record<string, string>
    chat: ProviderCapability.Outcome
    /** Read from `provider_connection` by the caller — see `probeLimits`. */
    limits?: ProbeLimits
  },
): Effect.Effect<ProviderCapability.Report & { readonly servedBy?: string }> =>
  Effect.gen(function* () {
    seenFingerprint = undefined
    const skip = (why: string) =>
      ProviderCapability.report({
        chat: input.chat,
        json: ProviderCapability.notAttempted(why),
        "native-tools": ProviderCapability.notAttempted(why),
        "text-tools": ProviderCapability.notAttempted(why),
      })
    // Every rung below asks the model to GENERATE. Without chat there is nothing to read, and asking
    // anyway would measure the same failure three more times and report it as three capabilities.
    if (input.chat.kind !== "supported") return skip("the endpoint did not return a plain completion")

    const spec = ProviderCapability.WIRES[input.wire]
    // ⚠️ Not 64. A reasoning model spends its budget BEFORE the first content token, and at 64 the
    // JSON rung came back empty and scored `unsupported` for a format the endpoint handles. It is
    // also the room the whole tool call needs: a budget too small truncates the arguments, and the
    // probe would then measure OUR budget and record it as the endpoint's failure.
    const limits = input.limits ?? probeLimits(undefined)
    const base = spec.base(input.modelID, limits.maxTokens)
    const ask = (body: Record<string, unknown>) =>
      capabilityAsk(client, { ...input, path: spec.path, body, timeout: limits.timeout })

    const json =
      spec.jsonMode === undefined
        ? // Not `unsupported`: this wire has no response-format parameter, so there is nothing for the
          // endpoint to have refused. Blaming a server for its wire's vocabulary would be a permanent
          // wrong verdict about a capability nobody asked it for.
          ProviderCapability.notAttempted(`the ${spec.path} wire has no response-format parameter to ask with`)
        : ProviderCapability.outcomeOf(
            yield* ask({
              ...base,
              ...spec.jsonMode.request,
              ...spec.ask('Reply with only this JSON object: {"ok":true}'),
            }),
            {
              parameter: spec.jsonMode.parameter,
              read: (payload) => {
                if (!spec.answered(payload)) return malformed()
                const spent = budgetFault(spec, payload)
                if (spent) return spent
                try {
                  JSON.parse(spec.text(payload))
                  return { kind: "supported" }
                } catch {
                  return {
                    kind: "unsupported",
                    detail: "The endpoint accepted a JSON response format and answered prose.",
                  }
                }
              },
            },
          )

    const nativeTools = ProviderCapability.outcomeOf(
      yield* ask({
        ...base,
        ...spec.offerCaptureTool(),
        ...spec.ask(`Call ${ProviderCapability.CAPTURE_TOOL.name} once with all three arguments filled in.`),
      }),
      {
        parameter: spec.toolsParameter,
        read: (payload) => {
          if (!spec.answered(payload)) return malformed()
          // ⚠️ AFTER the tool-call check, not before: a native call arrives with empty text on both
          // wires, so a budget test first would score every healthy native answer as a fault.
          const call = spec.toolCall(payload)
          if (call === undefined) {
            const spent = budgetFault(spec, payload)
            if (spent) return spent
          }
          return ProviderCapability.readToolCall(call, [ProviderCapability.CAPTURE_TOOL.name])
        },
      },
    )

    const textTools = ProviderCapability.outcomeOf(
      yield* ask({ ...base, ...spec.ask(ProviderCapability.TEXT_TOOL_PROMPT) }),
      {
        read: (payload) => {
          if (!spec.answered(payload)) return malformed()
          const spent = budgetFault(spec, payload)
          if (spent) return spent
          return ProviderCapability.readToolCall(
            ProviderCapability.recoverTextToolCall(spec.text(payload), [ProviderCapability.CAPTURE_TOOL.name]),
            [ProviderCapability.CAPTURE_TOOL.name],
          )
        },
      },
    )

    return {
      ...ProviderCapability.report({ chat: input.chat, json, "native-tools": nativeTools, "text-tools": textTools }),
      // `skip` returns before any request, so a skipped negotiation carries no identity — correct:
      // nothing answered, so nothing served it.
      ...(seenFingerprint === undefined ? {} : { servedBy: seenFingerprint }),
    }
  })

type CompletionProbe =
  | { readonly kind: "ok"; readonly latencyMs: number }
  | {
      readonly kind: "failed"
      readonly latencyMs: number
      readonly status: "auth" | "unreachable" | "error"
      readonly detail: string
    }

/** A tiny real generation through the endpoint's native wire shape. It is bounded independently
 * from discovery because a healthy slow model can legitimately need much longer than GET /models. */
export const probeCompletion = (
  client: HttpClient.HttpClient,
  input: {
    baseURL: string
    modelID: string
    wire: ProbeWire
    headers: Record<string, string>
    /** From `provider_connection.completion_timeout_ms`; defaulted when a caller has no config. */
    timeoutMs?: number
  },
): Effect.Effect<CompletionProbe> => {
  const timeoutMs = input.timeoutMs ?? ConfigProviderConnection.DEFAULT_COMPLETION_TIMEOUT_MS
  const path =
    input.wire === "anthropic-messages" ? "messages" : input.wire === "openai-responses" ? "responses" : "chat/completions"
  const url = `${input.baseURL.replace(/\/+$/, "")}/${path}`
  const body =
    input.wire === "anthropic-messages"
      ? { model: input.modelID, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1, stream: false }
      : input.wire === "openai-responses"
        ? {
            model: input.modelID,
            input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }],
            // A reasoning model spends this before its first output item, so 16 may come back empty —
            // still a 200 with the right envelope, which is all this probe claims to prove.
            max_output_tokens: 16,
            stream: false,
          }
        : {
            model: input.modelID,
            messages: [{ role: "user", content: "Reply OK" }],
            max_tokens: 1,
            temperature: 0,
            stream: false,
          }
  const started = Date.now()
  return client
    .execute(
      HttpClientRequest.post(url, {
        headers: new Headers({ ...input.headers, "content-type": "application/json" }),
        body: HttpBody.jsonUnsafe(body),
      }),
    )
    .pipe(
      Effect.flatMap((response) => {
        const latencyMs = Date.now() - started
        if (response.status === 401 || response.status === 403)
          return Effect.succeed<CompletionProbe>({
            kind: "failed",
            status: "auth",
            latencyMs,
            detail: `Generation rejected the credentials (HTTP ${response.status}).`,
          })
        if (response.status < 200 || response.status >= 300)
          return response.text.pipe(
            Effect.map(
              (text): CompletionProbe => ({
                kind: "failed",
                status: "error",
                latencyMs,
                detail: `Generation returned HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`,
              }),
            ),
          )
        return response.json.pipe(
          Effect.map((value): CompletionProbe => {
            const valid =
              input.wire === "anthropic-messages"
                ? typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content)
                : input.wire === "openai-responses"
                  ? typeof value === "object" && value !== null && Array.isArray((value as { output?: unknown }).output)
                  : typeof value === "object" && value !== null && Array.isArray((value as { choices?: unknown }).choices)
            return valid
              ? { kind: "ok", latencyMs }
              : {
                  kind: "failed",
                  status: "error",
                  latencyMs,
                  detail: "Generation answered, but its JSON did not match this endpoint's response format.",
                }
          }),
          Effect.catch(() =>
            Effect.succeed<CompletionProbe>({
              kind: "failed",
              status: "error",
              latencyMs,
              detail: "Generation answered with invalid JSON.",
            }),
          ),
        )
      }),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.succeed<CompletionProbe>({
            kind: "failed",
            status: "unreachable",
            latencyMs: Date.now() - started,
            // ⚠️ This sentence used to end "increase its connection timeout" while the bound it hit
            // was compiled in — pointing at `stall_timeout_ms`, which governs a streaming turn and
            // never this. A repair instruction naming a knob that cannot repair it is worse than
            // none, so the knob now exists and the sentence names it.
            detail:
              `The model accepted discovery but did not generate within ` +
              `${Duration.toSeconds(Duration.millis(timeoutMs))} seconds. It may be loading or overloaded; ` +
              `try again, or raise provider_connection.completion_timeout_ms.`,
          }),
      }),
      Effect.catch((error) =>
        Effect.succeed<CompletionProbe>({
          kind: "failed",
          status: "unreachable",
          latencyMs: Date.now() - started,
          detail: `Discovery worked, but generation could not connect: ${transportDetail(error).slice(0, 240)}`,
        }),
      ),
    )
}

/**
 * Exercise the generation route, applying this endpoint's session affinity when it is known and
 * LEARNING it from the endpoint's own 400 when it is not.
 *
 * The Settings Test is the one provider caller outside the runner, and it used to send neither the
 * header nor the recovery: an endpoint the runner had already learned — or would learn on its own
 * first turn — still reported `Generation returned HTTP 400: MissingSessionID` here. That is the
 * diagnostic contradicting the product. This is the same lesson the runner learns, at the second
 * site that needs it; the runner's own route-default application is in
 * `core/src/session/runner/model.ts`.
 *
 * Bounded at two requests: one to hear the refusal, one to prove the named header answers it. A
 * second refusal after that header is a different fault and is reported, not retried — the same
 * news-only rule the runner uses.
 */
export const probeCompletionWithAffinity = (
  client: HttpClient.HttpClient,
  input: {
    baseURL: string
    modelID: string
    wire: ProbeWire
    headers: Record<string, string>
    settings: Pick<SettingsConfigStore.Interface, "all" | "set">
    timeoutMs?: number
  },
): Effect.Effect<{
  readonly probe: CompletionProbe
  readonly attempts: number
  readonly latencyMs: number
  readonly header: string | undefined
}> =>
  Effect.gen(function* () {
    const withAffinity = (header: string | undefined) => ({
      ...input.headers,
      ...(ProviderSession.headersFor({ header, sessionID: undefined }) ?? {}),
    })
    const attempt = (header: string | undefined) =>
      probeCompletion(client, {
        baseURL: input.baseURL,
        modelID: input.modelID,
        wire: input.wire,
        headers: withAffinity(header),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      })
    const stored = yield* ProviderSession.storedAffinityHeader(input.settings, input.baseURL)
    const first = yield* attempt(stored)
    const unchanged = { probe: first, attempts: 1, latencyMs: first.latencyMs, header: stored }
    if (
      first.kind !== "failed" ||
      !ProviderSession.rejectsMissingSession(first.detail) ||
      ProviderSession.isAffinityKnown(input.baseURL)
    )
      return unchanged
    const learned = ProviderSession.requiredHeaderFrom(first.detail) ?? ProviderSession.FALLBACK_AFFINITY_HEADER
    if (learned === stored) return unchanged
    ProviderSession.rememberAffinity(input.baseURL, learned)
    yield* ProviderSession.persistAffinityHeader(input.settings, input.baseURL, learned)
    const second = yield* attempt(learned)
    return { probe: second, attempts: 2, latencyMs: first.latencyMs + second.latencyMs, header: learned }
  })

/** The package a wire is written as, when the endpoint teaches us which one it serves. */
const PACKAGE_FOR_WIRE: Readonly<Record<ProbeWire, ConfigProviderPreset.ApiChannel>> = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
}

/**
 * Exercise the generation route, applying this endpoint's session affinity and — when the CONFIGURED
 * wire is refused — learning the wire the endpoint actually serves this model on.
 *
 * 🔴 Some gateways serve different models on different protocols: measured 2026-09-21, one answers
 * `muse-spark-1.3-contributor` only on `/responses` and its sibling `glm-5.3-flash` only on
 * `/chat/completions`. NovaClaw cannot know which without being told, and a provider-wide channel
 * cannot express a mixed gateway — so the endpoint's own refusal is the evidence, exactly as it is
 * for the session header beside this. The owner re-added such a model and Test still failed for
 * want of a channel nobody could guess.
 *
 * Bounded: the configured wire (at most twice for affinity), then each other wire once. Only an
 * `error` refusal is treated as evidence about the WIRE; an auth failure or a dead socket is not.
 * `learn` is false for an UNSAVED endpoint, which has no model row to write a channel onto.
 */
export const probeCompletionLearningWire = (
  client: HttpClient.HttpClient,
  input: {
    baseURL: string
    modelID: string
    wire: ProbeWire
    headers: Record<string, string>
    settings: Pick<SettingsConfigStore.Interface, "all" | "set">
    timeoutMs?: number
    learn: boolean
  },
): Effect.Effect<{
  readonly probe: CompletionProbe
  readonly attempts: number
  readonly latencyMs: number
  readonly wire: ProbeWire
  readonly learned?: ConfigProviderPreset.ApiChannel
}> =>
  Effect.gen(function* () {
    const attempt = (wire: ProbeWire) =>
      probeCompletionWithAffinity(client, {
        baseURL: input.baseURL,
        modelID: input.modelID,
        wire,
        headers: input.headers,
        settings: input.settings,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      })
    const first = yield* attempt(input.wire)
    const unchanged = { probe: first.probe, attempts: first.attempts, latencyMs: first.latencyMs, wire: input.wire }
    if (first.probe.kind !== "failed" || first.probe.status !== "error" || !input.learn) return unchanged
    // The configured wire was refused. Ask the others; the first that answers is the one this
    // endpoint serves the model on.
    const others = (Object.keys(PACKAGE_FOR_WIRE) as ProbeWire[]).filter((candidate) => candidate !== input.wire)
    let attempts = first.attempts
    let latencyMs = first.latencyMs
    for (const candidate of others) {
      const next = yield* attempt(candidate)
      attempts += next.attempts
      latencyMs += next.latencyMs
      if (next.probe.kind === "ok")
        return { probe: next.probe, attempts, latencyMs, wire: candidate, learned: PACKAGE_FOR_WIRE[candidate] }
    }
    return { probe: first.probe, attempts, latencyMs, wire: input.wire }
  })

/** Context-window spellings emitted by the OpenAI-compatible servers we support. */
export function modelContextWindow(model: Record<string, unknown>): number | undefined {
  const direct = positiveInteger(
    model.max_model_len ?? model.context_length ?? model.max_context_length ?? model.context_window,
  )
  if (direct !== undefined) return direct
  const meta = model.meta
  if (typeof meta !== "object" || meta === null) return undefined
  return positiveInteger((meta as Record<string, unknown>).n_ctx)
}

/** Output-limit spellings used by OpenRouter-style catalogs and compatible model servers. */
export function modelOutputLimit(model: Record<string, unknown>): number | undefined {
  return positiveInteger(
    model.max_completion_tokens ?? model.max_output_tokens ?? model.output_token_limit ?? model.outputTokenLimit,
  )
}

/** Keep limits attached to their model id; one endpoint may serve models with different capacities. */
export function discoveredModelLimits(
  models: ReadonlyArray<Record<string, unknown>>,
): Record<string, { context?: number; output?: number }> {
  return Object.fromEntries(
    models.flatMap((model) => {
      if (typeof model.id !== "string") return []
      const context = modelContextWindow(model)
      const output = modelOutputLimit(model)
      if (context === undefined && output === undefined) return []
      return [
        [model.id, { ...(context === undefined ? {} : { context }), ...(output === undefined ? {} : { output }) }],
      ]
    }),
  )
}

/** Discovery may safely expose one window only when every listed model declares the same one. */
export function sharedContextWindow(models: ReadonlyArray<Record<string, unknown>>): number | undefined {
  if (models.length === 0) return undefined
  const windows = models.map(modelContextWindow)
  const first = windows[0]
  return first !== undefined && windows.every((window) => window === first) ? first : undefined
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const locations = yield* LocationServiceMap.Service
    // The ONE shared HttpClient — `Offline.guard(FetchHttpClient)` from
    // `core/src/effect/app-node-platform.ts`. Resolvable here because `httpClient` is a member of the
    // compiled `app` graph that `httpapi/server.ts` provides to the whole route tree (the
    // workspace-routing middleware already resolves it the same way).
    const http = yield* HttpClient.HttpClient
    // Where a measured verdict survives the request that produced it. Deliberately NOT the provider
    // config: a measurement and an operator's choice must stay distinguishable, and a re-test that
    // overwrote a deliberate decision would be the worse half of merging them.
    const capabilityStore = yield* ProviderCapabilityStore.Service

    // F1-final: the provider catalog now comes from the V2 `Catalog` (config +
    // ModelsDev, seeded into CatalogStore), projected onto the V1 wire shape the
    // Models-UI consumes. `Catalog` is location-scoped, so resolve it through the
    // shared location-service map for the instance directory (cf. experimental.ts).
    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const directory = (yield* InstanceState.context).directory
      // : the four-call catalog read lives in `ProviderCatalogResult.listCatalog`, shared
      // with `cli/cmd/models.ts`. Only the directory differs between the two callers, so only this
      // provision is local.
      return yield* ProviderCatalogResult.listCatalog.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
    })

    // B15 (codehamr A8) — the config-drift killer: one GET {baseURL}/models round trip
    // validates URL + key + model listing and harvests the server-reported honored window
    // (vLLM max_model_len). Chosen over a root GET / (hangs on vLLM) and over a hello
    // completion (costs tokens). Never throws — every failure classifies into the result.
    // Provider-import presets: builtin defaults merged with the `provider_presets` config key.
    // Served fresh on every call so a runtime endpoint fix (self-healing PATCH /config) is
    // visible to the next import-flow open with no cache dance.
    const presets = Effect.fn("ProviderHttpApi.presets")(function* () {
      const config = yield* cfg.get()
      return ConfigProviderPreset.effective(config.provider_presets)
    })

    // ⚠️ `ProbePayload`, not a hand-written twin. The shape used to be re-typed here, so the schema
    // and the implementation were two lists that had to agree — and when `capabilities` was added to
    // the wire, the handler simply could not see it while everything still compiled.
    const probe = Effect.fn("ProviderHttpApi.probe")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProbePayload
    }) {
      // Read the provider from the location-scoped Catalog, the same source `list` above and every
      // other provider consumer uses. It used to read `Config.get().providers`, which has been EMPTY
      // since providers moved into `CatalogStore` (settings-in-SQLite): the write goes to the
      // catalog through the `providers` layered arm, and the config document keeps nothing. So a
      // Test on a SAVED model could only ever answer "no-url", while the New-Model dialog passed a
      // baseURL in the payload and worked. Two paths, one of them dead, and the dead one is the one
      // a user reaches from Settings.
      const directory = (yield* InstanceState.context).directory
      const scope = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))
      const entry = yield* Catalog.Service.use((c) => c.provider.get(ctx.params.providerID)).pipe(
        Effect.provide(scope),
        Effect.orElseSucceed(() => undefined),
      )
      // The saved MODEL comes from the same catalog: `api.id` is the upstream id to put on the wire
      // when it differs from ours, and `retry.attempts` bounds the completion probe. Resolved here
      // once rather than at each of the two use sites below.
      const savedModel = ctx.payload.modelID
        ? yield* Catalog.Service.use((c) =>
            c.model.get(ctx.params.providerID, ModelV2.ID.make(ctx.payload.modelID!)),
          ).pipe(
            Effect.provide(scope),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined
      // The endpoint URL lives on `api.url`; extra settings/apiKey are under api.settings and
      // request.body. Flatten them into the shape this probe reads (baseURL, apiKey).
      const options = {
        ...(entry?.api?.settings ?? {}),
        ...(entry?.request?.body ?? {}),
        ...(entry?.api?.url ? { baseURL: entry.api.url } : {}),
      } as Record<string, unknown>
      const catalog: Record<string, { api?: string }> = yield* ModelsDev.Service.use((s) => s.get()).pipe(
        Effect.orElseSucceed(() => ({})),
      )
      // Payload baseURL/apiKey (the New-Model discovery flow, an unsaved endpoint) win over the
      // saved-provider config; falling back to config then catalog keeps the Test-a-saved-model path.
      const requestedURL =
        ctx.payload.baseURL ??
        (typeof options.baseURL === "string" ? options.baseURL : undefined) ??
        catalog[ctx.params.providerID]?.api
      if (!requestedURL)
        return {
          status: "no-url" as const,
          // User-facing prose. This string is rendered verbatim in Settings, so it names the
          // missing thing and the action, not the two internal sources that were consulted.
          detail: "Add the server address for this provider (for example http://localhost:8000/v1), then test again.",
        }
      const apiKey =
        (ctx.payload.apiKey && ctx.payload.apiKey.length > 0 ? ctx.payload.apiKey : undefined) ??
        (typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined)
      // The MODEL's channel decides the wire, not a two-valued auth style: one provider can carry
      // models on different protocols (a gateway serves some on `/responses` and others on
      // `/chat/completions`), and the model's own `api.package` override is how that is expressed.
      // The saved model's merged channel wins; the provider entry is the fallback when the model is
      // not in the catalog yet (the New Model discovery flow, which carries no generation probe).
      const savedPackage = savedModel?.api?.type === "aisdk" ? savedModel.api.package : undefined
      const entryPackage = entry?.api?.type === "aisdk" ? entry.api.package : undefined
      const channel = savedPackage ?? entryPackage
      // Discovery auth style: an explicit payload wins (the import flow passes the preset's style);
      // else inferred from the channel; default bearer. Anthropic's /models requires x-api-key +
      // anthropic-version instead of a Bearer header.
      const authStyle = channel === "@ai-sdk/anthropic" ? "anthropic" : (ctx.payload.authStyle ?? "bearer")
      // ⚠️ `channel` is a free-form string on the wire; only the closed set the runner dispatches on
      // selects a wire, and anything else keeps the auth style's own wire rather than inventing one.
      const wire: ProbeWire =
        channel !== undefined && channel in WIRE_FOR_CHANNEL
          ? WIRE_FOR_CHANNEL[channel as ConfigProviderPreset.ApiChannel]
          : authStyle === "anthropic"
            ? "anthropic-messages"
            : "openai-chat"
      const authHeaders: Record<string, string> = apiKey
        ? authStyle === "anthropic"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` }
        : authStyle === "anthropic"
          ? { "anthropic-version": "2023-06-01" }
          : {}
      // Read THROUGH to the store, once per probe: every bound below is a property of the user's
      // hardware, and a settings change must not need a restart to take effect (ruling 3).
      const connection = (yield* cfg.get()).provider_connection
      const settings = yield* SettingsConfigStore.Service
      const started = Date.now()

      // ── The address on screen is not necessarily a base URL: normalize before probing ───────
      //
      // A person types what their provider's docs show — a host with no scheme, the full
      // `/v1/chat/completions` endpoint they copied, or a version-less mount. `probeDiscovery`
      // derives at most two base URLs (canonical `/v1/` first, the version-less fallback second)
      // and keeps the first that answers as a real OpenAI-compatible endpoint. The
      // competing-harness caveats this defends are named in `core/src/config/endpoint-url.ts`.
      const discovery = yield* probeDiscovery(http, {
        requestedURL,
        headers: authHeaders,
        timeoutMs: ConfigProviderConnection.discoveryTimeoutMs(connection),
      })
      if (discovery.kind === "invalid")
        return {
          status: "error" as const,
          latencyMs: Date.now() - started,
          detail: `"${requestedURL}" is not a web address. Enter the server address, for example http://localhost:8000/v1.`,
        }
      // The address to PERSIST is the one the endpoint actually answered on, not the line typed.
      const baseURL = discovery.selected.baseURL
      const transport = discovery.selected.transport
      const latencyMs = Date.now() - started
      // Every non-`ok` arm already carries the status the wire schema will show, including the
      // airgap refusal — which is `error` + an airgap-shaped detail, deliberately NOT `unreachable`.
      if (transport.kind !== "ok")
        return { status: transport.status, latencyMs, baseURL, detail: transport.detail }
      const body = transport.body
      const data =
        typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data)
          ? ((body as { data: unknown[] }).data as Array<Record<string, unknown>>)
          : []
      const listed = data
        .filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === "string")
        .slice(0, 50)
      const models = listed.map((item) => item.id)
      const limits = discoveredModelLimits(listed)
      const found = ctx.payload.modelID ? data.find((item) => item.id === ctx.payload.modelID) : undefined
      const configuredIDUnlisted = ctx.payload.modelID !== undefined && !found
      const window = found ? modelContextWindow(found) : sharedContextWindow(data)
      // A listing proves routing/auth only. Exercise the actual generation route as well, using the
      // configured upstream model id. This deliberately bypasses
      // the agent harness: Settings must remain able to diagnose a model that cannot run the harness.
      // `probeCompletionWithAffinity` also carries the endpoint's session-affinity lesson, so a
      // gateway the runner already knows about is diagnosed here the same way the runner treats it.
      let completionLatencyMs: number | undefined
      let completionAttempts: number | undefined
      // The wire generation actually ran on: the configured one, or the one the endpoint taught us
      // when it refused the configured wire. Capabilities and the stored fingerprint both follow it.
      let effectiveWire = wire
      let learnedPackage: ConfigProviderPreset.ApiChannel | undefined
      if (ctx.payload.modelID) {
        const wireModelID = ModelV2.ID.make(savedModel?.api?.id ?? ctx.payload.modelID)
        const completion = yield* probeCompletionLearningWire(http, {
          baseURL,
          modelID: wireModelID,
          wire,
          headers: authHeaders,
          settings,
          timeoutMs: ConfigProviderConnection.completionTimeoutMs(connection),
          // Only a SAVED model has a row to carry the learned channel; the New-Model discovery flow
          // probes an endpoint that has none.
          learn: ctx.payload.baseURL === undefined,
        })
        completionAttempts = completion.attempts
        completionLatencyMs = completion.latencyMs
        effectiveWire = completion.wire
        learnedPackage = completion.learned
        // Persist what the endpoint taught us, or the Test would pass while the very next TURN went
        // out on the wire that was refused. Best-effort: a store that will not write must not fail
        // the probe the user asked for.
        if (learnedPackage !== undefined)
          yield* ConfigStoreWrite.apply(
            {
              providers: {
                [ctx.params.providerID]: {
                  models: {
                    [ctx.payload.modelID]: {
                      api: { id: wireModelID, type: "aisdk" as const, package: learnedPackage },
                    },
                  },
                },
              },
            },
            { writer: "instance" },
          ).pipe(Effect.ignore)
        if (completion.probe.kind === "failed")
          return {
            status: completion.probe.status,
            latencyMs: Date.now() - started,
            baseURL,
            discoveryLatencyMs: latencyMs,
            completionLatencyMs,
            completionAttempts,
            completed: false,
            models,
            ...(Object.keys(limits).length === 0 ? {} : { limits }),
            ...(window === undefined ? {} : { window }),
            detail: `Model discovery is healthy. ${completion.probe.detail}`,
            ...(configuredIDUnlisted
              ? {
                  detail: `The configured id "${ctx.payload.modelID}" is not advertised by /models. Generation also failed: ${completion.probe.detail}`,
                }
              : {}),
          }
      }
      // CAPABILITY NEGOTIATION, only when asked and only once a plain completion has come back:
      // every rung generates, so without chat there is nothing to read and asking would measure the
      // same failure three more times under three different names.
      let capabilities: (ProviderCapability.Report & { readonly servedBy?: string }) | undefined
      if (ctx.payload.capabilities === true && ctx.payload.modelID) {
        const wireModel = savedModel?.api?.id ?? ctx.payload.modelID
        // The same affinity the completion probe just resolved (in-process memory wins over the
        // store), so a negotiation that follows a learned header is not asked without it.
        const affinity = yield* ProviderSession.storedAffinityHeader(settings, baseURL)
        capabilities = yield* probeCapabilities(http, {
          baseURL,
          modelID: wireModel,
          wire: effectiveWire,
          headers: {
            ...authHeaders,
            ...(ProviderSession.headersFor({ header: affinity, sessionID: undefined }) ?? {}),
          },
          // Chat is not re-asked: `probeCompletion` above already proved it, and a second identical
          // request would be a second chance to disagree with the first.
          chat: { kind: "supported" },
          // Read THROUGH to the store here, at the point of use — a user who raised the bound
          // because their local model is slow must not have to restart the instance for the very
          // next Re-test to honour it.
          limits: probeLimits(connection),
        })
        // 🔴 Remembered, or the measurement dies with the request that made it: the screen would
        // tell the user this endpoint needs prompted tools and the very next turn would go out
        // native again. Keyed on the fingerprint, so a server reloaded with a different chat
        // template simply has no entry rather than a stale one.
        //
        // ⚠️ NOT written when this probed an UNSAVED endpoint (`payload.baseURL` is the New-Model
        // discovery flow), for the same reason `ProbeWindow.remember` is skipped there: recording it
        // against the saved provider id would attribute a measurement to an endpoint it was never
        // taken from.
        if (ctx.payload.baseURL === undefined)
          yield* capabilityStore
            .put(ctx.params.providerID, ctx.payload.modelID, {
              choice: capabilities.choice,
              rationale: capabilities.rationale,
              measuredAt: Date.now(),
              endpoint: baseURL,
              ...(capabilities.servedBy === undefined ? {} : { servedBy: capabilities.servedBy }),
              fingerprint: ProviderCapability.fingerprint({
                endpoint: baseURL,
                model: wireModel,
                // The SAME wire the rungs used — a verdict recorded under one protocol name and
                // measured over another would compare as stale on every later lookup.
                protocol: effectiveWire,
              }),
            })
            // A store that will not write must not fail the probe: the user asked what this endpoint
            // can do, and they get that answer either way. The cost of the failure is that the next
            // turn re-measures, which is the behaviour before this store existed.
            .pipe(Effect.catchCause(() => Effect.void))
      }
      // T3 — remember the honored window so model resolution sizes the 1M context pack from
      // live truth, but only when this probed the SAVED provider endpoint: a payload baseURL
      // is the New-Model discovery flow probing an UNSAVED endpoint, and caching that against
      // the saved provider id would poison the runtime override.
      if (window !== undefined && ctx.payload.modelID !== undefined && ctx.payload.baseURL === undefined)
        ProbeWindow.remember(ctx.params.providerID, ctx.payload.modelID, window)
      const detail = [
        learnedPackage === undefined
          ? undefined
          : `The endpoint refused this model's configured API, so Nova switched it to ${learnedPackage}. Generation and every later turn now use that route.`,
        configuredIDUnlisted
          ? `Generation succeeded with configured id "${ctx.payload.modelID}", although /models advertises ${models.length ? models.map((id) => `"${id}"`).join(", ") : "no model ids"}. The server is accepting an alias.`
          : undefined,
      ]
        .filter((note): note is string => note !== undefined)
        .join(" ")
      return {
        status: "ok" as const,
        latencyMs: Date.now() - started,
        baseURL,
        discoveryLatencyMs: latencyMs,
        ...(completionLatencyMs === undefined ? {} : { completionLatencyMs }),
        ...(completionAttempts === undefined ? {} : { completionAttempts }),
        ...(ctx.payload.modelID === undefined ? {} : { completed: true }),
        ...(capabilities === undefined
          ? {}
          : {
              capabilities: {
                choice: capabilities.choice,
                rationale: capabilities.rationale,
                outcomes: Object.fromEntries(
                  Object.entries(capabilities.outcomes).map(([name, outcome]) => [
                    name,
                    {
                      kind: outcome.kind,
                      ...(outcome.kind === "unknown" ? { fault: outcome.fault } : {}),
                      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
                    },
                  ]),
                ),
              },
            }),
        ...(detail === "" ? {} : { detail }),
        models,
        ...(Object.keys(limits).length === 0 ? {} : { limits }),
        ...(window === undefined ? {} : { window }),
      }
    })

    return handlers.handle("list", list).handle("probe", probe).handle("presets", presets)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
