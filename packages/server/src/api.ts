import { makeDefaultApi } from "@novaclaw/protocol/api"
import { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { WorkspaceRoutingMiddleware } from "./middleware/workspace-routing"

type LocationMiddlewareService = (typeof LocationMiddleware)["Service"]
type SessionLocationMiddlewareService = (typeof SessionLocationMiddleware)["Service"]
type WorkspaceRoutingMiddlewareService = (typeof WorkspaceRoutingMiddleware)["Service"]

export type ServerApi = ReturnType<
  typeof makeDefaultApi<
    LocationMiddleware,
    LocationMiddlewareService,
    SessionLocationMiddleware,
    SessionLocationMiddlewareService,
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddlewareService
  >
>

type ServerApiOptions = {
  readonly locationMiddleware: typeof LocationMiddleware
  readonly sessionLocationMiddleware: typeof SessionLocationMiddleware
  readonly workspaceRoutingMiddleware: typeof WorkspaceRoutingMiddleware
}

const makeServerApi: (options: ServerApiOptions) => ServerApi = makeDefaultApi<
  LocationMiddleware,
  LocationMiddlewareService,
  SessionLocationMiddleware,
  SessionLocationMiddlewareService,
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddlewareService
>

export const Api: ServerApi = makeServerApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
  workspaceRoutingMiddleware: WorkspaceRoutingMiddleware,
})

export function runtimeApi(): HttpApi.HttpApi<"server", HttpApiGroup.Any> {
  // `Api` is built and checked above against its exact middleware-specialized type.
  // Runtime route assembly only reads the group values and must not re-expand the
  // full endpoint union across a declaration boundary.
  return Api as unknown as HttpApi.HttpApi<"server", HttpApiGroup.Any>
}
