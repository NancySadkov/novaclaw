import { Provider } from "@novaclaw/schema/provider"
import { LocalModel } from "@novaclaw/schema/local-model"
import { Location } from "@novaclaw/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ProviderNotFoundError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Provider.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.list",
          summary: "List providers",
          description: "Retrieve active AI providers so clients can show provider availability and configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.localModels", "/api/provider/local-models", {
      query: LocationQuery,
      success: LocalModel.Status,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.localModels",
          summary: "List managed local models",
          description:
            "List tested laptop-friendly models, live resource preflight, verified-download progress and managed llama.cpp status.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("provider.installLocalModel", "/api/provider/local-models/:profileID/install", {
      params: { profileID: Schema.String },
      query: LocationQuery,
      payload: Schema.Struct({ context: Schema.optional(Schema.Finite) }),
      success: LocalModel.Status,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.installLocalModel",
          summary: "Install a managed local model",
          description:
            "Start a resumable verified background installation. The instance-owned llama.cpp server remains stopped until this model receives a prompt.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("provider.stopLocalModel", "/api/provider/local-models/stop", {
      query: LocationQuery,
      success: LocalModel.Status,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.stopLocalModel",
          summary: "Stop managed local inference",
          description: "Stop an active managed-model install or unload the instance-owned llama.cpp model.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.Info),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.get",
          summary: "Get provider",
          description: "Retrieve a single AI provider so clients can inspect its availability and endpoint settings.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("provider.remove", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.remove",
          summary: "Remove provider",
          description:
            "Delete a config-defined provider from the instance catalog store (T10iv: a true key delete, not a disable-list hide). Takes effect fully on the next serve boot.",
        }),
      ),
  )
  .add(
    // ⚠️ `modelID` is a QUERY parameter, not a path segment, and that is forced rather than chosen:
    // model ids routinely contain slashes (`openai/gpt-oss-120b`,
    // `hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL`), so `/model/:modelID` would split one id
    // across several segments and never match.
    HttpApiEndpoint.delete("provider.removeModel", "/api/provider/:providerID/model", {
      params: { providerID: Provider.ID },
      query: Schema.Struct({ ...LocationQuery.fields, modelID: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.removeModel",
          summary: "Remove one model",
          description:
            "Delete a single model from a provider in the instance catalog store, keeping the provider itself (and so its endpoint URL, auth and request defaults). Instance-wide and durable. A model that is in no layer is a 404, never a cheerful 204.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "providers",
      description: "Experimental provider routes.",
    }),
  )
