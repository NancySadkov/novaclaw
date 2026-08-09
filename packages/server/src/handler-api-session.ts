import { makeSessionGroups } from "@novaclaw/protocol/groups/session"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
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

const sessionGroups = makeSessionGroups(LocationMiddleware, SessionLocationMiddleware, WorkspaceRoutingMiddleware)

export const SessionCatalogApi = fragment(sessionGroups[0])
export const SessionControlApi = fragment(sessionGroups[1])
export const SessionRuntimeApi = fragment(sessionGroups[2])
export const SessionObservationApi = fragment(sessionGroups[3])
