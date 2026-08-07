import { makeDefaultApi } from "@novaclaw/protocol/api"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { WorkspaceRoutingMiddleware } from "./middleware/workspace-routing"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
  workspaceRoutingMiddleware: WorkspaceRoutingMiddleware,
})
