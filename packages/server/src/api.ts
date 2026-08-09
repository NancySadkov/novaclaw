import { makeDefaultApi } from "@novaclaw/protocol/api"
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
