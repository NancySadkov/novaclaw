import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { Context } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

/**
 * The workspace-routing middleware KEY, split from its implementation.
 *
 * 🔴 **Why the key lives here and the layer does not.** Routing a request to the instance that owns
 * its session needs `Workspace.Service`, the control plane, an `HttpClient` and a WebSocket
 * constructor — all of which live in `packages/novaclaw`, which depends on this package. So the
 * implementation cannot move here. But the native API is *defined* in `packages/protocol` and
 * assembled in `packages/server/src/api.ts`, neither of which can see `packages/novaclaw`, so the
 * key could not stay there either: a group in `protocol` had no way to declare this middleware.
 *
 * ⚠️ **That is not a tidiness problem — it is why the native V2 API had NO workspace routing at all.**
 * `WorkspaceRoutingMiddleware` was attached group-by-group inside `packages/novaclaw`, so it covered
 * the older instance surface and silently missed every `/api/**` route. A prompt for a session owned
 * by a REMOTE workspace ran on the local machine, against the wrong working tree, and answered 200 —
 * indistinguishable from a correctly proxied call from the outside.
 *
 * The split mirrors `./session-location`, which had the same problem first.
 */
export class WorkspaceRouteContext extends Context.Service<
  WorkspaceRouteContext,
  {
    readonly directory: string
    readonly workspaceID?: WorkspaceV2.ID
  }
>()("@novaclaw/ExperimentalHttpApiWorkspaceRouteContext") {}

export class WorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<
  WorkspaceRoutingMiddleware,
  {
    provides: WorkspaceRouteContext
  }
>()("@novaclaw/ExperimentalHttpApiWorkspaceRouting") {}
