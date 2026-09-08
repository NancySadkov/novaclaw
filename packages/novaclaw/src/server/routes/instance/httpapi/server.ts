import { Config as EffectConfig, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import {
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigSeedStartup } from "@novaclaw/core/config-seed-startup"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunityDht } from "@novaclaw/core/community/dht"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Global } from "@novaclaw/core/global"
import * as Observability from "@novaclaw/core/observability"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { InstanceStore } from "@/project/instance-store"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { SkillDiscovery } from "@novaclaw/core/skill/discovery"
import { HostPressure } from "@/storage/host-pressure"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as SpawnPressure from "@/storage/spawn-pressure"
import { WorkerWatch } from "@/storage/worker-watch"
import { MoveSession } from "@novaclaw/core/control-plane/move-session"
import { Credential } from "@novaclaw/core/credential"
import { Database } from "@novaclaw/core/database/database"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionReceipt } from "@novaclaw/core/session/receipt"
import { CalendarScheduler } from "@novaclaw/core/schedule/scheduler"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { LocalModelRuntime } from "@/local-model/runtime"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { SessionDriveState } from "@novaclaw/core/session/runner/drive-state"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { NovaclawExternalDriverSource } from "../../../../messenger/external-driver-source"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { AgentStatus } from "@novaclaw/core/agent-status"
import { AgentStatusSampler } from "@novaclaw/core/agent-status/sampler"
import { SessionStore } from "@novaclaw/core/session/store"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { Offline } from "@novaclaw/core/offline"
import { fetchChangelog } from "../../../maintenance/changelog"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { EventV2 } from "@novaclaw/core/event"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { Npm } from "@novaclaw/core/npm"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { ProjectV2 } from "@novaclaw/core/project"
import { Ticket } from "@novaclaw/core/ticket"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { AgentRemoval } from "@novaclaw/core/agent/removal"
import { AgentReassignment } from "@novaclaw/core/agent/reassignment"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { ProviderCapabilityStore } from "@novaclaw/core/provider-capability-store"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { SessionTags } from "@novaclaw/core/session/tags"
import { SessionPresence } from "@novaclaw/core/session/presence"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@novaclaw/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { runtimeApi } from "@novaclaw/server/api"
import { PublicApi } from "./public"
import { authorizationLayer, authorizationRouterMiddleware, serverAuthorizationLayer } from "./middleware/authorization"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { adhocHandlers } from "./handlers/adhoc"
import { capabilityHandlers } from "./handlers/capability"
import { pluginHandlers } from "./handlers/plugin"
import { usageHandlers } from "./handlers/usage"
import { communityHandlers, communityPeerHandlers } from "./handlers/community"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { registryHandlers } from "./handlers/registry"
import { memoryHandlers } from "./handlers/memory"
import { mcpHandlers } from "./handlers/mcp"
import { policyHandlers } from "./handlers/policy"
import { providerHandlers } from "./handlers/provider"
import { shellHandlers } from "./handlers/shell"
import { syncHandlers } from "./handlers/sync"
import { vcsHandlers } from "./handlers/vcs"
import { handlers } from "@novaclaw/server/handlers"
import { ServerLocationServiceMap } from "@/location-service-map"
import { SessionExecutionWorker } from "@/session-worker/execution"
import { layer as locationLayer } from "@novaclaw/server/location"
import { sessionLocationLayer } from "@novaclaw/server/middleware/session-location"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@novaclaw/server/middleware/schema-error"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware, locationDisposerLayer } from "./lifecycle"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { emptyJsonBodyLayer } from "./middleware/empty-json-body"
import { mutationOriginLayer } from "./middleware/mutation-origin"
import { peerDoorLayer } from "./middleware/peer-door"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { Log } from "@novaclaw/schema/log"

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
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const globalHandlersWithAuth = globalHandlers.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlersWithAuth]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    adhocHandlers,
    capabilityHandlers,
    pluginHandlers,
    usageHandlers,
    communityHandlers,
    communityPeerHandlers,
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    registryHandlers,
    memoryHandlers,
    mcpHandlers,
    policyHandlers,
    providerHandlers,
    shellHandlers,
    syncHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  // `peerDoorLayer` — consent/airgap/size for the `communityPeer` group. Provided HERE, beside the
  // authorization middleware it mirrors, because both are group middleware on this API: the guard
  // that used to run on every request by comparing URL strings now runs on exactly the routes the
  // router matched to a peer endpoint. See middleware/peer-door.ts.
  Layer.provide([httpApiAuthLayer, peerDoorLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(runtimeApi()).pipe(
  // ⚠️ TWO handler sources for one API. `handlers` serves every group declared in
  // `packages/server`; `vcsHandlers` serves `server.vcs`, whose service lives in THIS package and is
  // therefore unreachable from there. The api's type requires every group be handled, so a missing
  // one is a compile error here rather than a 404 found by a user.
  Layer.provide([handlers, vcsHandlers]),
  // 🔴 `workspaceRoutingLive` — the line that was missing. `eventApiRoutes` and `instanceRoutes` both
  // had it; the NATIVE api did not, so no `/api/**` request was ever routed to the instance owning
  // its session. A prompt for a remotely-owned session ran locally, against the wrong working tree,
  // and answered 200 — which is exactly what a correctly proxied call looks like from outside.
  Layer.provide([serverAuthorizationLayer, v2SchemaErrorLayer, workspaceRoutingLive]),
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

/**
 * 🔴 NC-SEC-015 — the first-party maintenance broker.
 *
 * The renderer used to fetch `novaclaw.app/changelog.json` itself, and it CANNOT consult airgap
 * policy: the policy lives on the instance, and the renderer never reaches the wire. An instance the
 * user had airgapped therefore announced, once per version change, that its user had opened the app.
 *
 * ⚠️ A plain route rather than a typed protocol method, deliberately. This is a maintenance
 * side-channel for the first-party UI, not part of the API a third party builds against — putting it
 * in `PublicApi` would publish it in `/doc` as though it were.
 *
 * ⚠️ The upstream STATUS is passed through, because the caller's failure model turns on it: a 404 is
 * an answer and marks the version seen, a network silence is not and retries next launch.
 */
const maintenanceRoute = HttpRouter.use((router) =>
  router.add("GET", "/api/maintenance/changelog", () =>
    Effect.gen(function* () {
      // Plain router layers do not receive the compiled app services in their request context.
      // Read the same process-wide live policy ref that Offline.Service exposes; config writes
      // update this ref synchronously, so this remains one policy source without a route-only layer.
      const result = yield* fetchChangelog(Offline.currentPolicy())
      if (result.kind === "refused")
        // 403 with a named reason: the caller must be able to tell "your instance declined" from
        // "the host is down", because only one of them is something the user chose.
        return HttpServerResponse.jsonUnsafe({ error: "airgapped", detail: result.message }, { status: 403 })
      if (result.kind === "unreachable")
        return HttpServerResponse.jsonUnsafe({ error: "upstream-unreachable", detail: result.detail }, { status: 502 })
      return HttpServerResponse.text(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      })
    }),
  ),
).pipe(Layer.provide(authOnlyRouterLayer))

export function createUIRoute(embeddedWebUI?: Record<string, string>) {
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const flags = yield* RuntimeFlags.Service
      const serve = (request: HttpServerRequest.HttpServerRequest) =>
        serveUIEffect(request, { fs, disableEmbeddedWebUi: flags.disableEmbeddedWebUi, embeddedWebUI })
      // Effect's router intentionally has no HEAD registration verb: when HEAD has no direct match,
      // `asHttpEffect` retries the GET table. One GET route therefore covers exactly GET + HEAD,
      // while mutations fall through to the ordinary JSON/empty 404 instead of receiving index.html.
      yield* router.add("GET", "/*", serve)
    }),
  ).pipe(Layer.provide(authOnlyRouterLayer))
}

const uiRoute = createUIRoute()

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
  SettingsConfigStore.node,
  InstanceIdentityStore.node,
  /**
   * What each colleague is working on, for the Contacts row. Listed HERE because `agent.list` joins
   * it and the lifecycle sampler writes it — and because omitting it is invisible to `tsgo -b`: a
   * component can declare the dependency, everything compile green, and every route in the instance
   * answered "Service not found: @novaclaw/v2/AgentStatus". The comment below names the same hazard
   * for `ProjectFileCache`; this is the second time it has been the graph's missing node.
   */
  AgentStatus.node,
  // Event-driven task labels: prompt/compaction/settlement in, one coalesced agent component out.
  AgentStatusSampler.node,
  // Its two companions on the same seam: the sampler reads transcripts through `SessionStore` and
  // enters each colleague's own location through `LocationServiceMap`. Both are declared by the
  // sampler node; both must EXIST here, because this list is what the instance actually builds.
  SessionStore.node,
  LocationServiceMap.node,
  // ...and the client it asks for a line. Third and last of the sampler's additions.
  llmClient,
  // The folder's `novaclaw.json`, cached. Listed HERE so `POST /api/project` can invalidate the very
  // entry the kernel reads after it rewrites the file — exactly the hazard the comment below names:
  // without it the handler compiled green under `tsgo -b` and every write answered 500 with
  // "Service not found: @novaclaw/v2/ProjectFileCache" (measured, 7 route tests).
  ProjectFileCache.node,
  // Community P3/P4: contacts and channels are INSTANCE state, like the identity beside them. A
  // group whose services are missing here compiles green and answers 500 on every call.
  CommunityContacts.node,
  CommunityChannels.node,
  CommunityPeers.node,
  CommunityDirect.node,
  CommunityAnswer.node,
  CommunityObservation.node,
  CommunityOffer.node,
  CommunitySearch.node,
  CommunitySuccession.node,
  CommunitySync.node,
  CommunityTransport.node,
  CommunityDht.node,
  CommunityPost.node,
  SkillConfigStore.node,
  ReferenceConfigStore.node,
  Database.node,
  // The graph-memory engine — a per-process (per-instance) singleton like the DB. Provided at the
  // server-global scope so the HTTP handlers AND the location-scoped runner/kb-tool share ONE engine
  // (a second build would clobber the same on-disk snapshot). The capability handle is cheap at boot;
  // its client and consolidation fiber start only on the first memory operation.
  Memory.node,
  // Automatic session/agent recall has its own graph, settings and retention. Keep the capability
  // beside the explicit KB so HTTP export/erase and worker execution resolve the same instance store.
  WorldMemory.node,
  // The runner's cross-drain controller facts — a per-instance store like Memory, provided at the
  // server-global scope so the location-scoped runner (in-process) and the worker executor's bridge
  // reach ONE store. A second build would give the worker a store the next drain cannot see, which
  // is the defect the store exists to end.
  SessionDriveState.node,
  // One registry derived from this server's declared graph. Reading it is observational: idle
  // capabilities remain idle until a real consumer asks for them.
  CapabilityRegistry.node,
  // The EEVDF scheduler — a per-instance singleton, listed here so the HTTP diagnostics handler and the
  // location-scoped runner share ONE ledger (two builds would report different worlds).
  SessionScheduler.node,
  SessionExecutionAttempt.node,
  SessionReceipt.node,
  Auth.node,
  Config.node,
  Git.node,
  Ripgrep.node,
  HostPressure.node,
  // Demand-loaded local inference. The same global node is injected into every location's model
  // resolver and serves the Instance controls, so there is exactly one llama.cpp child per instance.
  LocalModelRuntime.managerNode,
  ModelsDev.node,
  Agent.node,
  Skill.node,
  SkillDiscovery.node,
  PermissionSaved.node,
  SessionProjector.node,
  // 🔴 The reassignment DELIVERY, registered where the sessions and the event bus are.
  //
  // ⚠️ It hung off `SessionV2.node` first, which this graph never builds — so a folder change wrote
  // the config, announced to nobody, and the colleague was never told. Measured 2026-08-21 by driving
  // a real `PATCH /config`: the chat stayed empty. The unit tests passed throughout, because they
  // registered a listener themselves; nothing tested that the SERVER registers one.
  AgentReassignment.node,
  // The other half of the config door: a colleague removed through `POST /api/config/remove` must
  // have its cabinet set aside like one retired through `DELETE /api/agent/:id`. Registered HERE for
  // the reason `AgentReassignment` is — a node the server never builds is a feature that ships dead,
  // which is how the reassignment notice spent a day doing nothing (`agent-removal-wiring.test.ts`).
  AgentRemoval.node,
  // Spawn asks the host whether it can afford another sub-agent. Listed HERE for the same reason the
  // two above are: `SpawnAdmission.check()` admits when nobody answers, so an unregistered probe is a
  // guard that ships inert rather than one that fails loudly.
  SpawnPressure.node,
  // Watches what the LIVE WORKER FLEET is holding, sampled from outside the workers. Listed here for
  // the same reason as the three above — an unlisted node ships dead — and warn-only by design: the
  // kill path must not be armed before this has shown what a healthy fleet looks like.
  WorkerWatch.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  MCP.node,
  McpAuth.node,
  Truncate.node,
  Format.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  InstanceStore.node,
  // The airgap policy holder. `httpClient` already depends on it, so listing it here does NOT add
  // a build: `LayerNode.compile` walks every root member through ONE cache, so this node resolves
  // to the same compiled layer `httpClient` gets (measured — see the build count in
  // test/server/httpapi-shell-offline.test.ts). What listing it buys is that the compiled graph
  // EXPORTS `Offline.Service`, so (a) `/shell/offline` can read its manifest off the service that
  // actually enforces the guard instead of recomputing the policy from sqlite per request, and
  // (b) the messenger stack below can leave Offline as a requirement — one declared source for the
  // service instead of two constructions that only agree because Effect happens to memoize the
  // shared module-level layer by reference.
  // 🔴 Installs the community consent gate at boot. Required in the SERVER graph rather than only
  // where community services are built, because the peer-door middleware runs on every request
  // whether or not those services exist — and without it the gate reads its safe default and the
  // door stays shut for everyone.
  CommunityConsent.node,
  Offline.node,
  httpClient,
  EventV2.node,
  // ⚠️ Listed because an HTTP handler now writes through it (`session.repointFolder`), and the
  // typecheck CANNOT tell you when it is missing: the handler compiled green and answered 500
  // "Service not found: @novaclaw/v2/SessionComponentRegistry" on every call. The session TOOL
  // reaches this registry through the location-scoped graph, so nothing here had needed it before.
  SessionComponentRegistry.node,
  // The provider probe writes its measured verdict here. Same trap as the two above: a missing
  // node compiles green and answers 500 on every capability probe.
  ProviderCapabilityStore.node,
  // Same reason as the registry above: the resolved-config handler reads it, and the typecheck
  // cannot tell you when it is missing from THIS graph. It resolves the layer a turn actually runs
  // against — the folder's tune folded in — so the view cannot disagree with the runner.
  SessionEffectiveConfig.node,
  SessionTags.node,
  // Same trap as the three above, and it bites harder here because presence is in memory: a
  // missing node compiles green and answers 500 "Service not found" on every heartbeat, which a
  // client would read as "nobody is attached" rather than as a fault.
  SessionPresence.node,
  ProjectV2.node,
  Ticket.node,
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
const messengerGatewayCapability = LayerNode.compile(MessengerGateway.sharedCapabilityNode).pipe(
  Layer.provide([messengerBase, MessengerPace.layer]),
)
const messengerLoginCapability = LayerNode.compile(MessengerLogin.sharedCapabilityNode).pipe(
  Layer.provide(messengerBase),
)
const messengerCapabilityHandles = Layer.mergeAll(messengerGatewayCapability, messengerLoginCapability)
const messengerServices = Layer.mergeAll(messengerBase, messengerGatewayCapability, messengerLoginCapability)
const messengerCapabilityStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const gateway = yield* MessengerGateway.CapabilityService
    const login = yield* MessengerLogin.CapabilityService
    yield* registry.register("messenger", gateway)
    yield* registry.register("messenger-login", login)
    // Inbound transports must connect without waiting for the Messenger screen to be opened. Start
    // the gateway asynchronously so a refusal is cached and reported without delaying or killing boot.
    yield* Effect.forkScoped(gateway.get.pipe(Effect.asVoid))
  }),
).pipe(Layer.provide(messengerCapabilityHandles))
const calendarSchedulerCapability = LayerNode.compile(CalendarScheduler.sharedCapabilityNode)
const calendarSchedulerStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const scheduler = yield* CalendarScheduler.CapabilityService
    yield* registry.register("calendar-scheduler", scheduler)
    yield* Effect.forkScoped(scheduler.get.pipe(Effect.asVoid))
  }),
).pipe(Layer.provide(calendarSchedulerCapability))

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
    if (seeded.created.length > 0)
      yield* Log.event("server.recipes.seeded", { "server.created": seeded.created.length })
  }).pipe(Effect.catchCause(() => Effect.void)),
)

const catalogSeedStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const global = yield* Global.Service
    yield* ConfigSeedStartup.seedAll(global.config, global.home)
  }),
)

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    maintenanceRoute,
    uiRoute,
    // Not a route: it registers the "release this directory's location graph on instance disposal"
    // disposer. Merged as a ROOT rather than provided to a group, because it used to live inside the
    // pty handler group — which made every dispose path (the `/instance` endpoint, direct reloads,
    // shutdown) contingent on the Terminal routes being mounted. See `./lifecycle`.
    locationDisposerLayer,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      // Refuses a mutation carrying a foreign `Origin` — the CSRF shape a passwordless install is
      // open to. Ordered before the body middlewares so nothing is read for a request we refuse.
      mutationOriginLayer,
      emptyJsonBodyLayer,
      cors(corsOptions),
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(Observability.layer),

    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    // Before the SessionV2/app provides so the messenger stack's own requirements (SessionV2,
    // EventV2, Database, Global) resolve to the SAME memoized instances the routes use.
    Layer.provide(messengerServices),
    Layer.provideMerge(messengerCapabilityStartup),
    // The scheduler capability starts asynchronously and captures the shared SessionV2/Database/Global.
    // A constructor refusal is registered as recovery data instead of killing the server layer.
    Layer.provideMerge(calendarSchedulerStartup),
    Layer.provide(
      SessionV2.defaultLayer.pipe(
        // Close SessionV2's execution requirement at its own provider boundary. This is the same
        // module-level worker layer whose inner implementation the graph binding below uses, so the
        // shared MemoMap still builds one coordinator.
        Layer.provide(SessionExecutionWorker.defaultLayer),
        // V2 runner's location services, with MCP tools injected: replace core's empty
        // ExternalToolSource node with the novaclaw MCP-backed one so searxng et al. appear.
        Layer.provide(sharedLocationServiceMap),
      ),
    ),
    // Recovery controls call the same worker executor directly to resume a paused durable queue.
    Layer.provide(SessionExecutionWorker.defaultLayer),
    // The SAME map instance serves the HTTP routes' LocationMiddleware. Two separate maps here
    // means two per-location PermissionV2 instances — a runner's pending ask could then never be
    // settled over HTTP (the reply route would look in the wrong instance's pending map).
    Layer.provide(sharedLocationServiceMap),

    Layer.provideMerge(catalogSeedStartup),
    Layer.provideMerge(recipeSeedStartup),
    // Every admitted server drain crosses a disposable worker process. Workspace and recovery
    // controls receive this SAME graph-owned executor; core's local executor remains available only
    // to non-server embeddings/tests. Its dependencies resolve here instead of escaping the graph.
    Layer.provide(AppNodeBuilder.build(app, [[SessionExecution.node, SessionExecutionWorker.node]])),
  )
}

export const routes = createRoutes()

/**
 * Build and use the in-process Fetch handler inside the caller's Effect runtime.
 *
 * Effect's stock `HttpRouter.toWebHandler` intentionally defers its layer build until the first
 * request, then starts that build with a bare `Effect.runPromise`. For the headless `run` command
 * that loses AppRuntime's logger context, so startup records are printed by Effect's default logger
 * onto stdout — corrupting both plain and JSON CLI output. Keeping construction in this Effect also
 * gives the route graph a real scope instead of a module-global handler that can never be released.
 */
export const buildWebHandler = Effect.gen(function* () {
  const scope = Scope.makeUnsafe()
  // HttpRouter's Request markers describe the eventual request Effect; they are not services
  // needed while building the layer. `HttpRouter.toWebHandler` performs the same narrowing
  // internally before its lazy build.
  const handlerLayer = Layer.provideMerge(routes, HttpRouter.layer) as Layer.Layer<
    HttpRouter.HttpRouter,
    EffectConfig.ConfigError
  >
  const services = yield* Layer.buildWithMemoMap(handlerLayer, memoMap, scope).pipe(
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.orDie,
  )
  const router = Context.get(services, HttpRouter.HttpRouter)
  const handler = HttpEffect.toWebHandlerWith<HttpRouter.HttpRouter, HttpServerRequest.HttpServerRequest | Scope.Scope>(
    services,
  )(router.asHttpEffect(), disposeMiddleware)
  return {
    handler: (request: Request) => handler(request),
    dispose: Scope.close(scope, Exit.void),
  }
})

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
