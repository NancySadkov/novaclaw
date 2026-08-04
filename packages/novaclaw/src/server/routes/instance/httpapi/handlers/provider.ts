import { Config } from "@/config/config"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { ProbeWindow } from "@novaclaw/core/probe-window"
import { ProviderCatalogResult } from "@/provider/catalog-result"
import { Catalog } from "@novaclaw/core/catalog"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { InstanceState } from "@/effect/instance-state"

import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { isEgressBlocked } from "@novaclaw/llm"
import { InstanceHttpApi } from "../api"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { ProviderV2 } from "@novaclaw/core/provider"

/** How long one probe may take end to end (connect + headers + body). */
const PROBE_TIMEOUT = "5 seconds"
const COMPLETION_TIMEOUT = "45 seconds"

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
 * models* EGRESSED with airgap mode ON — while `/shell/offline` reported 9/9 layers active and
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
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.succeed<ProbeTransport>({
          kind: "unreachable",
          status: "unreachable",
          detail: `No answer within ${PROBE_TIMEOUT}.`,
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
    authStyle: ConfigProviderPreset.AuthStyle
    headers: Record<string, string>
  },
): Effect.Effect<CompletionProbe> => {
  const anthropic = input.authStyle === "anthropic"
  const url = `${input.baseURL.replace(/\/+$/, "")}/${anthropic ? "messages" : "chat/completions"}`
  const body = anthropic
    ? { model: input.modelID, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1, stream: false }
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
            const valid = anthropic
              ? typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content)
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
        duration: COMPLETION_TIMEOUT,
        orElse: () =>
          Effect.succeed<CompletionProbe>({
            kind: "failed",
            status: "unreachable",
            latencyMs: Date.now() - started,
            detail: `The model accepted discovery but did not generate within ${COMPLETION_TIMEOUT}. It may be loading or overloaded; try again or increase its connection timeout.`,
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

    // F1-final: the provider catalog now comes from the V2 `Catalog` (config +
    // ModelsDev, seeded into CatalogStore), projected onto the V1 wire shape the
    // Models-UI consumes. `Catalog` is location-scoped, so resolve it through the
    // shared location-service map for the instance directory (cf. experimental.ts).
    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const providers = yield* catalog.provider.all()
        const models = yield* catalog.model.all()
        const available = yield* catalog.provider.available()
        return ProviderCatalogResult.listResult({
          providers,
          models,
          connected: available.map((p) => p.id),
        })
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
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

    const probe = Effect.fn("ProviderHttpApi.probe")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: {
        modelID?: string | undefined
        baseURL?: string | undefined
        apiKey?: string | undefined
        authStyle?: ConfigProviderPreset.AuthStyle | undefined
      }
    }) {
      const config = yield* cfg.get()
      const entry = config.providers?.[ctx.params.providerID]
      // V2 provider config has no flat `options`: the endpoint URL lives on `api.url`, and any extra
      // settings/apiKey are under api.settings / request.body. Flatten them into the shape this probe
      // reads (baseURL, apiKey).
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
      const baseURL =
        ctx.payload.baseURL ??
        (typeof options.baseURL === "string" ? options.baseURL : undefined) ??
        catalog[ctx.params.providerID]?.api
      if (!baseURL)
        return {
          status: "no-url" as const,
          detail: "No baseURL is configured for this provider and its catalog entry has no API URL.",
        }
      const apiKey =
        (ctx.payload.apiKey && ctx.payload.apiKey.length > 0 ? ctx.payload.apiKey : undefined) ??
        (typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined)
      const url = `${baseURL.replace(/\/+$/, "")}/models`
      // Discovery auth style: explicit payload wins (the import flow passes the preset's style);
      // else infer from the saved provider's API channel; default bearer. Anthropic's /models
      // requires x-api-key + anthropic-version instead of a Bearer header.
      const authStyle =
        ctx.payload.authStyle ??
        (entry?.api?.type === "aisdk" && entry.api.package === "@ai-sdk/anthropic" ? "anthropic" : "bearer")
      const authHeaders: Record<string, string> = apiKey
        ? authStyle === "anthropic"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` }
        : authStyle === "anthropic"
          ? { "anthropic-version": "2023-06-01" }
          : {}
      const started = Date.now()
      const transport = yield* probeEndpoint(http, url, authHeaders)
      const latencyMs = Date.now() - started
      // Every non-`ok` arm already carries the status the wire schema will show, including the
      // airgap refusal — which is `error` + an airgap-shaped detail, deliberately NOT `unreachable`.
      if (transport.kind !== "ok") return { status: transport.status, latencyMs, detail: transport.detail }
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
      // configured upstream model id and bounded per-model retry count. This deliberately bypasses
      // the agent harness: Settings must remain able to diagnose a model that cannot run the harness.
      let completionLatencyMs: number | undefined
      let completionAttempts: number | undefined
      if (ctx.payload.modelID) {
        const savedModel = entry?.models?.[ctx.payload.modelID] as
          | { api?: { id?: string }; retry?: { attempts?: number } }
          | undefined
        const wireModelID = savedModel?.api?.id ?? ctx.payload.modelID
        const attempts = Math.max(1, Math.min(5, Math.trunc(savedModel?.retry?.attempts ?? 1)))
        let completion: CompletionProbe | undefined
        for (let attempt = 1; attempt <= attempts; attempt++) {
          completionAttempts = attempt
          completion = yield* probeCompletion(http, { baseURL, modelID: wireModelID, authStyle, headers: authHeaders })
          completionLatencyMs = (completionLatencyMs ?? 0) + completion.latencyMs
          if (completion.kind === "ok" || completion.status === "auth" || completion.status === "error") break
        }
        if (completion?.kind === "failed")
          return {
            status: completion.status,
            latencyMs: Date.now() - started,
            discoveryLatencyMs: latencyMs,
            completionLatencyMs,
            completionAttempts,
            completed: false,
            models,
            ...(Object.keys(limits).length === 0 ? {} : { limits }),
            ...(window === undefined ? {} : { window }),
            detail: `Model discovery is healthy. ${completion.detail}`,
            ...(configuredIDUnlisted
              ? {
                  detail: `The configured id "${ctx.payload.modelID}" is not advertised by /models. Generation also failed: ${completion.detail}`,
                }
              : {}),
          }
      }
      // T3 — remember the honored window so model resolution sizes the 1M context pack from
      // live truth, but only when this probed the SAVED provider endpoint: a payload baseURL
      // is the New-Model discovery flow probing an UNSAVED endpoint, and caching that against
      // the saved provider id would poison the runtime override.
      if (window !== undefined && ctx.payload.modelID !== undefined && ctx.payload.baseURL === undefined)
        ProbeWindow.remember(ctx.params.providerID, ctx.payload.modelID, window)
      return {
        status: "ok" as const,
        latencyMs: Date.now() - started,
        discoveryLatencyMs: latencyMs,
        ...(completionLatencyMs === undefined ? {} : { completionLatencyMs }),
        ...(completionAttempts === undefined ? {} : { completionAttempts }),
        ...(ctx.payload.modelID === undefined ? {} : { completed: true }),
        ...(configuredIDUnlisted
          ? {
              detail: `Generation succeeded with configured id "${ctx.payload.modelID}", although /models advertises ${models.length ? models.map((id) => `"${id}"`).join(", ") : "no model ids"}. The server is accepting an alias.`,
            }
          : {}),
        models,
        ...(Object.keys(limits).length === 0 ? {} : { limits }),
        ...(window === undefined ? {} : { window }),
      }
    })

    return handlers.handle("list", list).handle("probe", probe).handle("presets", presets)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
