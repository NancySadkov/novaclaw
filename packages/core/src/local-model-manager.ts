export * as LocalModelManager from "./local-model-manager"

import { Context, Effect } from "effect"
import type { LocalModel } from "@novaclaw/schema/local-model"
import type { ConfigLocalModelCatalog } from "./config/local-model-catalog"

export interface Interface {
  readonly status: (overrides?: ConfigLocalModelCatalog.Info) => Effect.Effect<LocalModel.Status, never>
  readonly start: (
    profileID: string,
    context?: number,
    overrides?: ConfigLocalModelCatalog.Info,
  ) => Effect.Effect<LocalModel.Status, never>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/LocalModelManager") {}
