import { Schema } from "effect"
import { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { EventV2 } from "@novaclaw/core/event"
import { EventManifest } from "@/event-manifest"
import { Credential } from "@novaclaw/core/credential"
import { Integration } from "@novaclaw/core/integration"
import { SkillV2 } from "@novaclaw/core/skill"
import { AdhocApi } from "./groups/adhoc"
import { CapabilityApi } from "./groups/capability"
import { CommunityApi, CommunityPeerApi } from "./groups/community"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { MemoryApi } from "./groups/memory"
import { PluginApi } from "./groups/plugin"
import { PolicyApi } from "./groups/policy"
import { ProviderApi } from "./groups/provider"
import { RegistryApi } from "./groups/registry"
import { ShellApi } from "./groups/shell"
import { SyncApi } from "./groups/sync"
import { UsageApi } from "./groups/usage"
import { runtimeApi } from "@novaclaw/server/api"
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
]).annotate({ identifier: "Event" })

/**
 * The `/api/*` surface — the SAME object the router mounts, not a second declaration of it.
 *
 * 🔴 **This used to be a private re-construction** — `makeApi({ definitions: EventManifest.Latest…
 * })` — and it published a `GET /api/event` contract the route could not honour. The bus carries
 * `EventManifest.Definitions`; the served handler (`@novaclaw/server/handlers/event`) narrows to
 * `ServerDefinitions ∪ server.connected`, about twenty types fewer, and drops the rest by design.
 * So the spec promised arms — `session.status`, `permission.*`, `question.*`, `mcp.*`,
 * `workspace.*`, `worktree.*` — that a conforming client would wait for forever. Nothing failed:
 * the two declarations simply drifted, because `makeApi`'s `definitions` parameter is checked
 * against nothing.
 *
 * ⚠️ **The fix is to stop having two.** `runtimeApi()` is what `HttpApiBuilder.layer` serves
 * (`./server.ts`), so generating the spec from it makes the contract and the implementation one
 * value — divergence is not a bug you can reintroduce here, it is a statement that cannot be
 * written. The middleware wiring, including the shared workspace-routing KEY, now has exactly one
 * home: `packages/server/src/api.ts`.
 */
export const ServerApi: HttpApi.HttpApi<"server", HttpApiGroup.Any> = runtimeApi()

export const RootHttpApi = HttpApi.make("novaclaw-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(GlobalApi)
  .middleware(ExperimentalSchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("novaclaw-instance")
  .addHttpApi(AdhocApi)
  .addHttpApi(CapabilityApi)
  .addHttpApi(PluginApi)
  .addHttpApi(UsageApi)
  .addHttpApi(CommunityApi)
  .addHttpApi(CommunityPeerApi)
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(MemoryApi)
  .addHttpApi(PolicyApi)
  .addHttpApi(RegistryApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(ShellApi)
  .addHttpApi(SyncApi)
  .middleware(ExperimentalSchemaErrorMiddleware)

// OpenAPI generation reads the runtime groups below. Widen the exported declaration so adding a
// public event does not force TypeScript to serialize the entire endpoint+event union at this boundary.
export const NovaClawHttpApi: HttpApi.HttpApi<"novaclaw", HttpApiGroup.Any> = HttpApi.make("novaclaw")
  .addHttpApi(RootHttpApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
    SkillV2.Source,
  ])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
