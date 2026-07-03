import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { Provider } from "@/provider/provider"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
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
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(connected),
      }
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
    const probe = Effect.fn("ProviderHttpApi.probe")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: { modelID?: string | undefined }
    }) {
      const config = yield* cfg.get()
      const entry = config.provider?.[ctx.params.providerID]
      const options = (entry?.options ?? {}) as Record<string, unknown>
      const catalog: Record<string, { api?: string }> = yield* ModelsDev.Service.use((s) => s.get()).pipe(
        Effect.orElseSucceed(() => ({})),
      )
      const baseURL =
        (typeof options.baseURL === "string" ? options.baseURL : undefined) ?? catalog[ctx.params.providerID]?.api
      if (!baseURL)
        return {
          status: "no-url" as const,
          detail: "No baseURL is configured for this provider and its catalog entry has no API URL.",
        }
      const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined
      const url = `${baseURL.replace(/\/+$/, "")}/models`
      const started = Date.now()
      const response = yield* Effect.tryPromise(() =>
        fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
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
      return { status: "ok" as const, latencyMs, models, ...(window === undefined ? {} : { window }) }
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
      .handle("probe", probe)
  }),
)
