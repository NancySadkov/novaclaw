import { ProviderAuth } from "@/provider/auth"
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

import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { ProviderV2 } from "@novaclaw/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const locations = yield* LocationServiceMap.Service
    const svc = yield* ProviderAuth.Service

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

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
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
      const response = yield* Effect.tryPromise(() =>
        fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
          headers: authHeaders,
        }),
      ).pipe(Effect.catch((error) => Effect.succeed(String((error as { cause?: unknown }).cause ?? error))))
      const latencyMs = Date.now() - started
      if (typeof response === "string")
        return { status: "unreachable" as const, latencyMs, detail: response.slice(0, 300) }
      if (response.status === 401 || response.status === 403)
        return { status: "auth" as const, latencyMs, detail: `HTTP ${response.status}` }
      if (!response.ok) return { status: "error" as const, latencyMs, detail: `HTTP ${response.status}` }
      const body = yield* Effect.tryPromise(() => response.json() as Promise<unknown>).pipe(
        Effect.orElseSucceed(() => undefined),
      )
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
      const window = found && typeof found.max_model_len === "number" ? found.max_model_len : undefined
      // T3 — remember the honored window so model resolution sizes the 1M context pack from
      // live truth, but only when this probed the SAVED provider endpoint: a payload baseURL
      // is the New-Model discovery flow probing an UNSAVED endpoint, and caching that against
      // the saved provider id would poison the runtime override.
      if (window !== undefined && ctx.payload.modelID !== undefined && ctx.payload.baseURL === undefined)
        ProbeWindow.remember(ctx.params.providerID, ctx.payload.modelID, window)
      return { status: "ok" as const, latencyMs, models, ...(window === undefined ? {} : { window }) }
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
      .handle("probe", probe)
      .handle("presets", presets)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
