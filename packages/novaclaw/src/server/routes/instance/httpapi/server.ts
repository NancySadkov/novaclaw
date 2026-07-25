import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@novaclaw/core/fs-util"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigSeedStartup } from "@novaclaw/core/config-seed-startup"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Global } from "@novaclaw/core/global"
import * as Observability from "@novaclaw/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@novaclaw/core/control-plane/move-session"
import { Credential } from "@novaclaw/core/credential"
import { Database } from "@novaclaw/core/database/database"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { CalendarScheduler } from "@novaclaw/core/schedule/scheduler"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { NovaclawExternalDriverSource } from "../../../../messenger/external-driver-source"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { Offline } from "@novaclaw/core/offline"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { EventV2 } from "@novaclaw/core/event"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { Npm } from "@novaclaw/core/npm"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { ProjectV2 } from "@novaclaw/core/project"
import { PtyTicket } from "@novaclaw/core/pty/ticket"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTags } from "@novaclaw/core/session/tags"
import * as SessionExecutionLocal from "@novaclaw/core/session/execution/local"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@novaclaw/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@novaclaw/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { adhocHandlers } from "./handlers/adhoc"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { registryHandlers } from "./handlers/registry"
import { memoryHandlers } from "./handlers/memory"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { shellHandlers } from "./handlers/shell"
import { syncHandlers } from "./handlers/sync"
import { handlers } from "@novaclaw/server/handlers"
import { ServerLocationServiceMap } from "@/location-service-map"
import { layer as locationLayer } from "@novaclaw/server/location"
import { sessionLocationLayer } from "@novaclaw/server/middleware/session-location"
import { PtyEnvironment } from "@novaclaw/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@novaclaw/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { emptyJsonBodyLayer } from "./middleware/empty-json-body"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

// ONE location-service map for the whole server — the shared `ServerLocationServiceMap.layer`
// (same value everywhere, so Effect memoization builds it once). The V2 runner, the HTTP routes,
// AND the Agent/file/pty handlers MUST share per-location service instances — PermissionV2's
// pending-ask map lives in one of them. A second `buildLocationServiceMap` call here used to
// split the runner's locations from the Agent-graph's (two maps, two PermissionV2s per
// directory) — a runner ask could then never be settled over HTTP.
const sharedLocationServiceMap = ServerLocationServiceMap.layer

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    adhocHandlers,
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    registryHandlers,
    memoryHandlers,
    mcpHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    shellHandlers,
    syncHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Global.node,
  AgentConfigStore.node,
  CatalogStore.node,
  CommandConfigStore.node,
  PluginConfigStore.node,
  SettingsConfigStore.node,
  InstanceIdentityStore.node,
  SkillConfigStore.node,
  ReferenceConfigStore.node,
  Database.node,
  // The graph-memory engine — a per-process (per-instance) singleton like the DB. Provided at the
  // server-global scope so the HTTP handlers AND the location-scoped runner/kb-tool share ONE engine
  // (a second build would clobber the same on-disk snapshot). Opens only when NOVACLAW_KB_MEMORY is set.
  Memory.node,
  // The EEVDF scheduler — a per-instance singleton, listed here so the HTTP diagnostics handler and the
  // location-scoped runner share ONE ledger (two builds would report different worlds).
  SessionScheduler.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  SessionProjector.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  MCP.node,
  McpAuth.node,
  Truncate.node,
  Format.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  SessionTags.node,
  ProjectV2.node,
  PtyTicket.node,
])

// The Messenger stack (messenger-plan §3.2: "the gateway is instance-global — it lives on the
// INSTANCE, server-side"). The /api/messenger group is instance-global (no location middleware),
// so unlike the location-scoped groups its services must be provided to the HTTP context here.
// Wiring rules: siblings that need each other are provided INTERNALLY (base → gateway/login);
// everything else (Database, EventV2, SessionV2, Global) is left as a requirement so the pipe's
// LATER provides satisfy it with the SAME instances every other route uses — the gateway must
// prompt into THE SessionV2, never a second one (the one-LocationServiceMap lesson generalized).
// ⚠️ Found 2026-07-22 (P1.7 boot smoke): P0/P1 never added this — every /api/messenger route
// 500'd "Service not found" on the real serve path (the fake-proven pipeline all ran against the
// @novaclaw/server test assembly). This block is what makes the messenger real in the product.
// MessengerDrivers now composes builtin ∪ ExternalDriverSource (§3.6 plugin-driver seam). The
// novaclaw-side source contributes out-of-kernel drivers the instance opts into (WhatsApp/Baileys
// behind NOVACLAW_ENABLE_WHATSAPP); it's builtin-only when nothing is enabled.
const messengerBase = Layer.mergeAll(
  MessengerStore.layer,
  MessengerDrivers.layer.pipe(Layer.provide(NovaclawExternalDriverSource.layer)),
  Credential.layer,
)
const messengerServices = Layer.mergeAll(
  messengerBase,
  MessengerGateway.layer.pipe(Layer.provide([messengerBase, MessengerPace.layer, Offline.layer])),
  MessengerLogin.layer.pipe(Layer.provide(messengerBase)),
)

// Settings → SQLite: run the ONE first-boot import pass (every per-subsystem store) at server
// startup, BEFORE any location boots — so every dir (incl. the shared scratch dir) sees the
// same settings, rather than a scratch-first access finding empty stores. Idempotent + best-
// effort: seedAll ignores per-seed failures; a seed failure must never block startup. The V1
// config service runs the same pass on its first read (CLI entry points), so this is a cheap
// no-op on every boot after the first. See core/config-seed-startup.ts.
// Recipes: write any missing SHIPPED recipe to disk at startup (AGENTS.md → recipes are source code for
// the AI era). Idempotent and non-destructive — a user's edit to a shipped recipe survives, and a deleted
// one returns, so the set doubles as an always-available install health check. Best-effort: a seed failure
// must never block startup.
const recipeSeedStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const seeded = yield* Effect.promise(() => RecipeBuiltin.seed())
    if (seeded.created.length > 0) yield* Effect.logInfo("seeded recipes", { created: seeded.created })
  }).pipe(Effect.catchCause(() => Effect.void)),
)

const catalogSeedStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const global = yield* Global.Service
    yield* ConfigSeedStartup.seedAll(global.config, process.cwd(), global.home)
  }),
)

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      emptyJsonBodyLayer,
      cors(corsOptions),
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(Observability.layer),

    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    // Before the SessionV2/app provides so the messenger stack's own requirements (SessionV2,
    // EventV2, Database, Global) resolve to the SAME memoized instances the routes use.
    Layer.provide(messengerServices),
    // Calendar scheduler poll loop — same requirement-leaving pattern as the messenger: it must reach the
    // SHARED SessionV2/Database/Global (never a second SessionV2), so it is provided BEFORE the SessionV2
    // provide. provideMerge (like catalogSeedStartup) guarantees the background fiber is built + started.
    Layer.provideMerge(CalendarScheduler.layer),
    Layer.provide(
      SessionV2.defaultLayer.pipe(
        Layer.provide(SessionExecutionLocal.defaultLayer),
        // V2 runner's location services, with MCP tools injected: replace core's empty
        // ExternalToolSource node with the novaclaw MCP-backed one so searxng et al. appear.
        Layer.provide(sharedLocationServiceMap),
      ),
    ),
    // The SAME map instance serves the HTTP routes' LocationMiddleware. Two separate maps here
    // means two per-location PermissionV2 instances — a runner's pending ask could then never be
    // settled over HTTP (the reply route would look in the wrong instance's pending map).
    Layer.provide(sharedLocationServiceMap),

    Layer.provideMerge(catalogSeedStartup),
    Layer.provideMerge(recipeSeedStartup),
    Layer.provide(LayerNode.compile(app)),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
