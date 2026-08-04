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
  discoveryLatencyMs: Schema.optional(Schema.Number),
  completionLatencyMs: Schema.optional(Schema.Number),
  completionAttempts: Schema.optional(Schema.Number),
  completed: Schema.optional(Schema.Boolean),
  window: Schema.optional(Schema.Number),
  limits: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        context: Schema.optional(Schema.Number),
        output: Schema.optional(Schema.Number),
      }),
    ),
  ),
  detail: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})
export type ProbeResult = Schema.Schema.Type<typeof ProbeResult>

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
