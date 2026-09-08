import { WorkspaceV2 } from "@novaclaw/core/workspace"
import type { Target } from "@/control-plane/types"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Database } from "@novaclaw/core/database/database"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionRead } from "@novaclaw/core/session/read"
import { HttpApiProxy } from "./proxy"
import * as Fence from "@/server/shared/fence"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute, workspaceProxyURL } from "@/server/shared/workspace-routing"
import { Flag } from "@novaclaw/core/flag/flag"
import { existsSync } from "node:fs"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { WorkspaceRouteContext, WorkspaceRoutingMiddleware } from "@novaclaw/server/middleware/workspace-routing"
import * as Socket from "effect/unstable/socket/Socket"
import { InvalidRequestError } from "../errors"

// Query fields this middleware reads from the URL. Spread into every
// endpoint query schema in groups that apply WorkspaceRoutingMiddleware,
// otherwise HttpApi rejects requests carrying these params with 400.
// HttpApiMiddleware in effect-smol cannot declare query params today —
// remove this once upstream supports middleware-declared query schemas.
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export const WorkspaceRoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)

type RemoteTarget = Extract<Target, { type: "remote" }>

type RequestPlan = Data.TaggedEnum<{
  InvalidWorkspace: {}
  InvalidDirectory: { readonly directory: string }
  MissingWorkspace: { readonly workspaceID: WorkspaceV2.ID }
  Local: { readonly directory: string; readonly workspaceID?: WorkspaceV2.ID }
  Remote: {
    readonly request: HttpServerRequest.HttpServerRequest
    readonly workspace: Workspace.Info
    readonly target: RemoteTarget
    readonly url: URL
  }
}>
const RequestPlan = Data.taggedEnum<RequestPlan>()
const InvalidWorkspaceID = Symbol("InvalidWorkspaceID")

// 🔴 The KEYS moved to `@novaclaw/server/middleware/workspace-routing` and are re-exported here so
// the twelve existing declaration sites keep their import. They had to move: the native API is
// defined in `packages/protocol` and assembled in `packages/server`, neither of which can see this
// package — which is precisely why `/api/**` had no workspace routing at all. The LAYER stays here,
// because it needs `Workspace.Service`, the control plane and an HttpClient. See that file.
export { WorkspaceRouteContext, WorkspaceRoutingMiddleware }

function requestURL(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.url, "http://localhost")
}

function configuredWorkspaceID(): WorkspaceV2.ID | undefined {
  return Flag.NOVACLAW_WORKSPACE_ID ? WorkspaceV2.ID.make(Flag.NOVACLAW_WORKSPACE_ID) : undefined
}

function selectedWorkspaceID(url: URL, sessionWorkspaceID?: WorkspaceV2.ID): WorkspaceV2.ID | undefined {
  const workspaceParam = url.searchParams.get("workspace")
  return sessionWorkspaceID ?? (workspaceParam ? WorkspaceV2.ID.make(workspaceParam) : undefined)
}

function selectedV2WorkspaceID(
  url: URL,
  sessionWorkspaceID?: WorkspaceV2.ID,
): WorkspaceV2.ID | typeof InvalidWorkspaceID | undefined {
  if (sessionWorkspaceID) return sessionWorkspaceID
  const workspaceParam = url.searchParams.get("workspace")
  if (!workspaceParam) return undefined
  const workspaceID = Schema.decodeUnknownOption(WorkspaceV2.ID)(workspaceParam)
  if (Option.isNone(workspaceID)) return InvalidWorkspaceID
  return workspaceID.value
}

/**
 * The directory a request names, as a real path.
 *
 * 🔴 **The HEADER is percent-ENCODED by the SDK and must be decoded; the query param must not be.**
 * `packages/sdk/js/src/v2/client.ts` sends `x-novaclaw-directory: encodeURIComponent(directory)`, so
 * on Windows `C:\Users\…` arrives as `C%3A%5CUsers%5C…`. `URL.searchParams.get` already decodes, and
 * `packages/server/src/location.ts` decodes the header — this module did not, in BOTH places that
 * read it, which is the asymmetry that produced the bug.
 *
 * ⚠️ Consequence, and it is not cosmetic: the existence guard in `planRequest` tested `existsSync` on
 * the ENCODED string, so it never matched and every SDK request carrying a directory but no session
 * was rejected 400 `Directory does not exist: C%3A%5C…`. The 400 also masked the second half — this
 * function would otherwise have handed the literal `C%3A%5C…` to instance boot as a directory.
 */
const requestedDirectory = (request: HttpServerRequest.HttpServerRequest, url: URL): string | undefined => {
  const query = url.searchParams.get("directory")
  if (query) return query
  const header = request.headers["x-novaclaw-directory"]
  if (!header) return undefined
  try {
    return decodeURIComponent(header)
  } catch {
    // A malformed escape is the client's problem, but it is not a reason to throw here: hand the raw
    // value on and let the existence guard reject it with the value the client actually sent.
    return header
  }
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  return requestedDirectory(request, url) || process.cwd()
}

function shouldStayOnControlPlane(request: HttpServerRequest.HttpServerRequest, url: URL): boolean {
  return isLocalWorkspaceRoute(request.method, url.pathname) || url.pathname.startsWith("/console")
}

function resolveWorkspace(
  id: WorkspaceV2.ID | undefined,
  envWorkspaceID: WorkspaceV2.ID | undefined,
): Effect.Effect<Workspace.Info | void, never, Workspace.Service> {
  if (!id || envWorkspaceID) return Effect.void
  return Workspace.Service.use((workspace) => workspace.get(id))
}

function missingWorkspaceResponse(id: WorkspaceV2.ID): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(`Workspace not found: ${id}`, {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function resolveTarget(workspace: Workspace.Info): Effect.Effect<Target> {
  return WorkspaceAdapterRuntime.target(workspace)
}

function proxyRemote(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  workspace: Workspace.Info,
  target: RemoteTarget,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor | Workspace.Service> {
  return Effect.gen(function* () {
    const syncing = yield* Workspace.Service.use((svc) => svc.isSyncing(workspace.id))
    if (!syncing) {
      return HttpServerResponse.text(`broken sync connection for workspace: ${workspace.id}`, {
        status: 503,
        contentType: "text/plain; charset=utf-8",
      })
    }
    const proxyURL = workspaceProxyURL(target.url, url)
    const headers = request.headers as Record<string, string>
    if (headers["upgrade"]?.toLowerCase() === "websocket") return yield* HttpApiProxy.websocket(request, proxyURL)
    const response = yield* HttpApiProxy.http(client, proxyURL, target.headers, request)
    const sync = Fence.parse(new Headers(response.headers))
    if (sync) {
      const syncFailure = yield* Fence.wait(
        workspace.id,
        sync,
        request.source instanceof Request ? request.source.signal : undefined,
      ).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 503 }))),
      )
      if (syncFailure) return syncFailure
    }
    return response
  })
}

function planWorkspaceRequest(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspace: Workspace.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const target = yield* resolveTarget(workspace)
    if (target.type === "remote") return RequestPlan.Remote({ request, workspace, target, url })
    return RequestPlan.Local({ directory: target.directory, workspaceID: workspace.id })
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  session?: SessionSchema.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const url = requestURL(request)
    const envWorkspaceID = configuredWorkspaceID()
    const workspaceID = url.pathname.startsWith("/api/")
      ? selectedV2WorkspaceID(url, session?.location.workspaceID)
      : selectedWorkspaceID(url, session?.location.workspaceID)
    if (workspaceID === InvalidWorkspaceID) return RequestPlan.InvalidWorkspace()
    const workspace = yield* resolveWorkspace(workspaceID, envWorkspaceID)

    if (workspaceID && workspace === undefined && !envWorkspaceID) {
      return RequestPlan.MissingWorkspace({ workspaceID })
    }

    if (workspace !== undefined && !envWorkspaceID && !shouldStayOnControlPlane(request, url)) {
      return yield* planWorkspaceRequest(request, url, workspace)
    }

    // A CLIENT-supplied directory (query param / header) must exist on disk before we hand it
    // to instance boot — any HTTP client could otherwise make the server create instances,
    // bootstrap dirs, and file-watchers on arbitrary junk paths (seen live: a mis-decoded
    // base64 route param booted instances on garbage-byte directories). Session-derived and
    // cwd-default directories are server-side truth and stay unvalidated.
    if (!session?.location.directory) {
      // Decoded — see `requestedDirectory`. Testing `existsSync` on the SDK's percent-encoded header
      // never matched, so this guard rejected every legitimate client-supplied directory.
      const requested = requestedDirectory(request, url)
      const deadFolderSessionList = request.method === "GET" && url.pathname === "/api/session"
      if (requested && !deadFolderSessionList && !(yield* Effect.sync(() => existsSync(requested)))) {
        return RequestPlan.InvalidDirectory({ directory: requested })
      }
    }

    return RequestPlan.Local({
      directory: session?.location.directory || defaultDirectory(request, url),
      workspaceID: envWorkspaceID ?? workspaceID,
    })
  })
}

function routeWorkspace<E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Socket.WebSocketConstructor | Workspace.Service> {
  return RequestPlan.$match(plan, {
    InvalidWorkspace: () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          new InvalidRequestError({
            message: "Invalid workspace query parameter",
            kind: "Query",
            field: "workspace",
          }),
          { status: 400 },
        ),
      ),
    InvalidDirectory: ({ directory }) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          new InvalidRequestError({
            message: `Directory does not exist: ${directory}`,
            kind: "Query",
            field: "directory",
          }),
          { status: 400 },
        ),
      ),
    MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
    Remote: ({ request, workspace, target, url }) => proxyRemote(client, request, workspace, target, url),
    Local: ({ directory, workspaceID }) =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory, workspaceID }))),
  })
}

function routeHttpApiWorkspace<E>(
  db: Database.Interface["db"],
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Workspace.Service | HttpServerRequest.HttpServerRequest | Socket.WebSocketConstructor
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessionID = getWorkspaceRouteSessionID(requestURL(request))
    const session = sessionID ? yield* SessionRead.get(db, sessionID) : undefined
    const plan = yield* planRequest(request, session)
    return yield* routeWorkspace(client, effect, plan)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const workspace = yield* Workspace.Service
    const client = yield* HttpClient.HttpClient
    const { db } = yield* Database.Service
    return WorkspaceRoutingMiddleware.of((effect) =>
      routeHttpApiWorkspace(db, client, effect).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        Effect.provideService(Workspace.Service, workspace),
      ),
    )
  }),
)
