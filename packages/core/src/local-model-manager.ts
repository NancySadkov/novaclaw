export * as LocalModelManager from "./local-model-manager"

import { Context, Effect, Layer, Schema } from "effect"
import type { LocalModel } from "@novaclaw/schema/local-model"
import type { ConfigLocalModelCatalog } from "./config/local-model-catalog"
import { makeGlobalNode } from "./effect/app-node"

export interface ModelRequest {
  readonly providerID: string
  readonly modelID: string
  readonly apiModelID: string
  readonly baseURL?: string
  readonly context?: number
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "LocalModelManager.UnavailableError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly status: (overrides?: ConfigLocalModelCatalog.Info) => Effect.Effect<LocalModel.Status, never>
  readonly install: (
    profileID: string,
    context?: number,
    overrides?: ConfigLocalModelCatalog.Info,
  ) => Effect.Effect<LocalModel.Status, never>
  /** Start the managed server only when a turn actually targets one of its models. */
  readonly ensure: (
    request: ModelRequest,
    overrides?: ConfigLocalModelCatalog.Info,
  ) => Effect.Effect<void, UnavailableError>
  readonly stop: () => Effect.Effect<LocalModel.Status, never>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/LocalModelManager") {}

const unsupported: LocalModel.Status = {
  supported: false,
  platform: `${process.platform}-${process.arch}`,
  profiles: [],
  stage: "idle",
  recommendedContext: 65_536,
}

/** Core-only runtimes have no managed sidecar. Server builds replace this global node. */
export const layer = Layer.succeed(
  Service,
  Service.of({
    status: () => Effect.succeed(unsupported),
    install: () => Effect.succeed(unsupported),
    ensure: () => Effect.void,
    stop: () => Effect.succeed(unsupported),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
