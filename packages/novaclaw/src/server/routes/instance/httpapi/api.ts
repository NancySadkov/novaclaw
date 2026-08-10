import { Schema } from "effect"
import { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { EventV2 } from "@novaclaw/core/event"
import { EventManifest } from "@/event-manifest"
import { Credential } from "@novaclaw/core/credential"
import { Integration } from "@novaclaw/core/integration"
import { SkillV2 } from "@novaclaw/core/skill"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { AdhocApi } from "./groups/adhoc"
import { CapabilityApi } from "./groups/capability"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { MemoryApi } from "./groups/memory"
import { ProviderApi } from "./groups/provider"
import { QuestionApi } from "./groups/question"
import { RegistryApi } from "./groups/registry"
import { ShellApi } from "./groups/shell"
import { SyncApi } from "./groups/sync"
import { WorkspaceApi } from "./groups/workspace"
import { makeApi } from "@novaclaw/protocol/api"
import { LocationMiddleware } from "@novaclaw/server/location"
import { SessionLocationMiddleware } from "@novaclaw/server/middleware/session-location"
import { WorkspaceRoutingMiddleware } from "@novaclaw/server/middleware/workspace-routing"
import { GlobalApi } from "./groups/global"
import { Authorization } from "./middleware/authorization"
import { ExperimentalSchemaErrorMiddleware } from "./middleware/schema-error"

const EventSchema: Schema.Schema<unknown> = Schema.Union([
  ...EventManifest.Latest.values()
    .map((definition) =>
      Schema.Struct({
        id: EventV2.ID,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    )
    .toArray(),
  InstanceDisposed,
]).annotate({ identifier: "Event" })

export const ServerApi = makeApi({
  definitions: EventManifest.Latest.values().toArray(),
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
  // The PROXYING implementation lives in this package (`./middleware/workspace-routing`); the KEY is
  // shared so `packages/protocol` can declare it on the native session group.
  workspaceRoutingMiddleware: WorkspaceRoutingMiddleware,
})

export const RootHttpApi = HttpApi.make("novaclaw-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(GlobalApi)
  .middleware(ExperimentalSchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("novaclaw-instance")
  .addHttpApi(AdhocApi)
  .addHttpApi(CapabilityApi)
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(MemoryApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(RegistryApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(ShellApi)
  .addHttpApi(SyncApi)
  .addHttpApi(WorkspaceApi)
  .middleware(ExperimentalSchemaErrorMiddleware)

// OpenAPI generation reads the runtime groups below. Widen the exported declaration so adding a
// public event does not force TypeScript to serialize the entire endpoint+event union at this boundary.
export const NovaClawHttpApi: HttpApi.HttpApi<"novaclaw", HttpApiGroup.Any> = HttpApi.make("novaclaw")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Question.Replied,
    Question.Rejected,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
    SkillV2.Source,
  ])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
