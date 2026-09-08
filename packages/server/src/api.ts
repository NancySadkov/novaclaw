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

/**
 * 🔴 **The ONE `/api/*` declaration.** Both the served routes and the published OpenAPI spec read
 * this object, so the contract and the implementation cannot describe different sets.
 *
 * ⚠️ That is a standing invariant, not a coincidence, and it was violated for as long as the app
 * package built its own copy with `makeApi({ definitions })`. Its event group was widened to the
 * whole bus manifest while the handler still narrowed to `ServerDefinitions`, and the two drifted in
 * silence because nothing compares a spec against the set a handler will emit. **Do not add a second
 * construction of this API; add to this one.**
 *
 * The PROXYING implementation of workspace routing lives in `packages/novaclaw`; only the KEY is
 * shared here, so `packages/protocol` can declare it on the native session group.
 */
export const Api: ServerApi = makeServerApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
  workspaceRoutingMiddleware: WorkspaceRoutingMiddleware,
})

/**
 * {@link Api}, widened. Used by route assembly AND by OpenAPI generation — deliberately the same
 * value, see the note above.
 */
export function runtimeApi(): HttpApi.HttpApi<"server", HttpApiGroup.Any> {
  // `Api` is built and checked above against its exact middleware-specialized type.
  // Consumers only read the group values and must not re-expand the full endpoint
  // union across a declaration boundary.
  return Api as unknown as HttpApi.HttpApi<"server", HttpApiGroup.Any>
}
