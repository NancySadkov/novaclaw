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
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { isEgressBlocked } from "@novaclaw/llm"
import { InstanceHttpApi } from "../api"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { ProviderV2 } from "@novaclaw/core/provider"

/** How long one probe may take end to end (connect + headers + body). */
const PROBE_TIMEOUT = "5 seconds"

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

/** Context-window spellings emitted by the OpenAI-compatible servers we support. */
export function modelContextWindow(model: Record<string, unknown>): number | undefined {
  const direct = model.max_model_len ?? model.context_length
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct > 0) return direct
  const meta = model.meta
  if (typeof meta !== "object" || meta === null) return undefined
  const nested = (meta as Record<string, unknown>).n_ctx
  return typeof nested === "number" && Number.isSafeInteger(nested) && nested > 0 ? nested : undefined
}

/** Discovery may safely expose one window only when every listed model declares the same one. */
export function sharedContextWindow(models: ReadonlyArray<Record<string, unknown>>): number | undefined {
  if (models.length === 0) return undefined
  const windows = models.map(modelContextWindow)
  const first = windows[0]
  return first !== undefined && windows.every((window) => window === first) ? first : undefined
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
      const models = data.flatMap((item) => (typeof item.id === "string" ? [item.id] : [])).slice(0, 50)
      const found = ctx.payload.modelID ? data.find((item) => item.id === ctx.payload.modelID) : undefined
      if (ctx.payload.modelID && !found)
        return {
          status: "model-missing" as const,
          latencyMs,
          models,
          detail: `Model "${ctx.payload.modelID}" is not in the server's /models list.`,
        }
      const window = found ? modelContextWindow(found) : sharedContextWindow(data)
      // T3 — remember the honored window so model resolution sizes the 1M context pack from
      // live truth, but only when this probed the SAVED provider endpoint: a payload baseURL
      // is the New-Model discovery flow probing an UNSAVED endpoint, and caching that against
      // the saved provider id would poison the runtime override.
      if (window !== undefined && ctx.payload.modelID !== undefined && ctx.payload.baseURL === undefined)
        ProbeWindow.remember(ctx.params.providerID, ctx.payload.modelID, window)
      return { status: "ok" as const, latencyMs, models, ...(window === undefined ? {} : { window }) }
    })

    return handlers.handle("list", list).handle("probe", probe).handle("presets", presets)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
