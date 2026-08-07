import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { Context, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
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
 * indistinguishable from a correctly proxied call from the outside. See `todo/assorted.md`.
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

/**
 * What directory a request names, decoded.
 *
 * 🔴 **One answer to this question, for every reader.** It used to have three: `./location.ts`
 * decoded the header, `novaclaw`'s routing middleware read it raw, and `defaultDirectory` read it raw
 * again. That disagreement was not academic — the raw readers tested `existsSync` on the SDK's
 * percent-encoded value, so every SDK request carrying a directory but no session was rejected
 * `400 Directory does not exist`, naming a path that exists.
 *
 * ⚠️ The header is percent-encoded and the query param is not: `URL.searchParams.get` decodes for you,
 * and double-decoding a path containing a literal `%` corrupts it. That asymmetry is the entire
 * reason this is a shared function rather than a convention.
 */
export const requestedDirectory = (headers: Record<string, string | undefined>, url: URL): string | undefined => {
  const query = url.searchParams.get("directory")
  if (query) return query
  const header = headers["x-novaclaw-directory"]
  if (!header) return undefined
  try {
    return decodeURIComponent(header)
  } catch {
    // A malformed escape is the client's problem. Hand the raw value on so whatever validates it can
    // reject it quoting what the client actually sent, rather than throwing here.
    return header
  }
}

/**
 * The LOCAL-ONLY implementation: everything runs here, nothing is proxied.
 *
 * 🔴 **This exists so the middleware can be DECLARED unconditionally.** The native session group has
 * to declare workspace routing — that is the whole fix; declaring it per-group is how `/api/**` got
 * missed. But this package has no control plane, no `Workspace.Service` and no proxy, so it cannot
 * implement routing. Without a default, declaring the middleware would make the API unbuildable here.
 *
 * ⚠️ **It is not a stub that pretends.** "This server owns every session it is asked about" is the
 * literal truth for a server with no workspaces, and it is what the code did before the middleware
 * existed. `packages/novaclaw` overrides it with the proxying implementation, which is the only build
 * that has anything to proxy TO.
 */
export const localWorkspaceRoutingLayer = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const directory = requestedDirectory(request.headers as Record<string, string | undefined>, url) ?? process.cwd()
      return yield* effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory })))
    }),
  ),
)
