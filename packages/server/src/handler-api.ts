import { AgentGroup } from "@novaclaw/protocol/groups/agent"
import { makeCalendarGroup } from "@novaclaw/protocol/groups/calendar"
import { CommandGroup } from "@novaclaw/protocol/groups/command"
import { ConfigGroup } from "@novaclaw/protocol/groups/config"
import { CredentialGroup } from "@novaclaw/protocol/groups/credential"
import { EventGroup } from "@novaclaw/protocol/groups/event"
import { DirectoryBrowseGroup, FileSystemGroup } from "@novaclaw/protocol/groups/fs"
import { MemoryGroup } from "@novaclaw/protocol/groups/memory"
import { HealthGroup } from "@novaclaw/protocol/groups/health"
import { IntegrationGroup } from "@novaclaw/protocol/groups/integration"
import { LocationGroup } from "@novaclaw/protocol/groups/location"
import { LogGroup } from "@novaclaw/protocol/groups/log"
import { MessageGroup } from "@novaclaw/protocol/groups/message"
import { MessengerGroup } from "@novaclaw/protocol/groups/messenger"
import { ModelGroup } from "@novaclaw/protocol/groups/model"
import { makePermissionGroup } from "@novaclaw/protocol/groups/permission"
import { ProviderGroup } from "@novaclaw/protocol/groups/provider"
import { PtyGroup } from "@novaclaw/protocol/groups/pty"
import { PtyInstanceGroup } from "@novaclaw/protocol/groups/pty-instance"
import { RecipeGroup } from "@novaclaw/protocol/groups/recipe"
import { AppGroup } from "@novaclaw/protocol/groups/app"
import { ReferenceGroup } from "@novaclaw/protocol/groups/reference"
import { SkillGroup } from "@novaclaw/protocol/groups/skill"
import { TelemetryGroup } from "@novaclaw/protocol/groups/telemetry"
import { QualityGroup } from "@novaclaw/protocol/groups/quality"
import { VcsGroup } from "@novaclaw/protocol/groups/vcs"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import type { Layer } from "effect"
import { HttpApi, type HttpApiGroup } from "effect/unstable/httpapi"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { WorkspaceRoutingMiddleware } from "./middleware/workspace-routing"

type ApiFragment<Group extends HttpApiGroup.Any> = HttpApi.HttpApi<
  "server",
  HttpApiGroup.AddMiddleware<HttpApiGroup.AddMiddleware<Group, Authorization>, SchemaErrorMiddleware>
>

const fragment = <Group extends HttpApiGroup.Any>(group: Group): ApiFragment<Group> =>
  HttpApi.make("server").add(group).middleware(Authorization).middleware(SchemaErrorMiddleware)

export const AgentApi = fragment(AgentGroup.middleware(LocationMiddleware))
export const CalendarApi = fragment(makeCalendarGroup(LocationMiddleware))
export const CommandApi = fragment(CommandGroup.middleware(LocationMiddleware))
export const ConfigApi = fragment(ConfigGroup)
export const CredentialApi = fragment(CredentialGroup.middleware(LocationMiddleware))
export const EventApi = fragment(EventGroup)
export const FileSystemApi = fragment(FileSystemGroup.middleware(LocationMiddleware))
export const DirectoryBrowseApi = fragment(DirectoryBrowseGroup)
export const HealthApi = fragment(HealthGroup)
export const MemoryApi = fragment(MemoryGroup)
export const IntegrationApi = fragment(IntegrationGroup.middleware(LocationMiddleware))
export const LocationApi = fragment(LocationGroup.middleware(LocationMiddleware))
export const LogApi = fragment(LogGroup)
export const MessageApi = fragment(
  MessageGroup.middleware(SessionLocationMiddleware).middleware(WorkspaceRoutingMiddleware),
)
export const MessengerApi = fragment(MessengerGroup)
export const ModelApi = fragment(ModelGroup.middleware(LocationMiddleware))
export const PermissionApi = fragment(
  makePermissionGroup(LocationMiddleware, SessionLocationMiddleware).middleware(WorkspaceRoutingMiddleware),
)
export const ProviderApi = fragment(ProviderGroup.middleware(LocationMiddleware))
export const PtyApi = fragment(PtyGroup.middleware(LocationMiddleware))
export const PtyInstanceApi = fragment(PtyInstanceGroup)
export const RecipeApi = fragment(RecipeGroup)
export const AppApi = fragment(AppGroup)
export const ReferenceApi = fragment(ReferenceGroup.middleware(LocationMiddleware))
export const SkillApi = fragment(SkillGroup.middleware(LocationMiddleware))
export const TelemetryApi = fragment(TelemetryGroup)
// ⚠️ Declared here, HANDLED in `packages/novaclaw`. The VCS service needs that package's `Git`,
// `InstanceState` and `EventV2Bridge`, none of which this package can see — and none of which it
// needs to, because a handler layer only has to satisfy the group's type. Every other fragment
// here happens to be served next door in `handlers/`; this one is the exception, and saying so is
// cheaper than letting the next reader conclude the handler was forgotten.
export const VcsApi = fragment(VcsGroup.middleware(LocationMiddleware))
export const QualityApi = fragment(QualityGroup.middleware(LocationMiddleware))

/** Name a handler layer's exact public contract without widening its error or service requirements. */
export function handlerLayer<Name extends string, Error, Requirements>(
  layer: Layer.Layer<HttpApiGroup.ApiGroup<"server", Name>, Error, Requirements>,
): Layer.Layer<HttpApiGroup.ApiGroup<"server", Name>, Error, Requirements> {
  return layer
}
