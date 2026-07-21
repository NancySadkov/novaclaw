import { ProviderAuth } from "@/provider/auth"
import { ProviderCatalogResult } from "@/provider/catalog-result"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { ProviderV2 } from "@novaclaw/core/provider"

const root = "/provider"

// B15 (codehamr A8) — one-shot provider/model health probe. GET {baseURL}/models validates
// URL + key + model listing in one round trip (a root GET / hangs on vLLM; a completion costs
// tokens). `window` carries the server-reported max_model_len where present (vLLM) — the
// HONORED context window, authoritative over config for display.
export const ProbeResult = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("ok"),
    Schema.Literal("unreachable"),
    Schema.Literal("auth"),
    Schema.Literal("model-missing"),
    Schema.Literal("no-url"),
    Schema.Literal("error"),
  ]),
  latencyMs: Schema.optional(Schema.Number),
  window: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})
export type ProbeResult = Schema.Schema.Type<typeof ProbeResult>

const ProviderAuthErrorName = Schema.Union([
  Schema.Literal("BadRequest"),
  Schema.Literal("ProviderAuthOauthMissing"),
  Schema.Literal("ProviderAuthOauthCodeMissing"),
  Schema.Literal("ProviderAuthOauthCallbackFailed"),
  Schema.Literal("ProviderAuthValidationFailed"),
])
export class ProviderAuthApiError extends Schema.ErrorClass<ProviderAuthApiError>("ProviderAuthError")(
  {
    name: ProviderAuthErrorName,
    data: Schema.Struct({
      providerID: Schema.optional(ProviderV2.ID),
      field: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderCatalogResult.ListResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderAuth.Methods, "Provider auth methods"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.AuthorizeInput,
          success: described(Schema.UndefinedOr(ProviderAuth.Authorization), "Authorization URL and method"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "Start OAuth authorization",
            description: "Start the OAuth authorization flow for a provider.",
          }),
        ),
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.CallbackInput,
          success: described(Schema.Boolean, "OAuth callback processed successfully"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "Handle OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
        HttpApiEndpoint.post("probe", `${root}/:providerID/probe`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          // baseURL/apiKey let the client probe an UNSAVED endpoint (the "New Model" discovery flow) —
          // when absent, the probe resolves them from the saved provider config as before.
          payload: Schema.Struct({
            modelID: Schema.optional(Schema.String),
            baseURL: Schema.optional(Schema.String),
            apiKey: Schema.optional(Schema.String),
            // Discovery auth style (provider-import presets): "anthropic" sends x-api-key +
            // anthropic-version instead of a Bearer header. Absent = inferred from the saved
            // provider's API channel, defaulting to bearer.
            authStyle: Schema.optional(ConfigProviderPreset.AuthStyle),
          }),
          success: described(ProbeResult, "Provider probe result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.probe",
            summary: "Probe a provider endpoint",
            description:
              "One-shot health probe: validates the provider URL, key, and (optionally) that a model is listed, in one GET /models round trip. Reports the server's honored context window where available.",
          }),
        ),
        HttpApiEndpoint.get("presets", `${root}/presets`, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Record(Schema.String, ConfigProviderPreset.Info),
            "Provider import presets (builtins merged with config overrides)",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.presets",
            summary: "List provider import presets",
            description:
              "The effective provider-import preset catalog: built-in defaults merged field-wise with the `provider_presets` config key, so endpoint fixes applied at runtime (self-healing) are always reflected.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "novaclaw experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
