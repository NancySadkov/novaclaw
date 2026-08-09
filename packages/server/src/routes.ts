import { localWorkspaceRoutingLayer } from "./middleware/workspace-routing"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { EventV2 } from "@novaclaw/core/event"
import { Credential } from "@novaclaw/core/credential"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { PtyTicket } from "@novaclaw/core/pty/ticket"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTags } from "@novaclaw/core/session/tags"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { runtimeApi } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  Database.maintenanceNode,
  SettingsConfigStore.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  SessionTags.node,
  SessionExecutionAttempt.node,
  SessionExecution.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  LocationServiceMap.node,
  MessengerStore.node,
  MessengerDrivers.node,
  MessengerGateway.capabilityNode,
  MessengerLogin.capabilityNode,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.layer({ username: "novaclaw", password: Option.some(password) })
      : ServerAuth.Config.defaultLayer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.layer({ username: "novaclaw", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  return HttpApiBuilder.layer(runtimeApi(), { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    // Local-only: this package has no control plane to proxy to. `packages/novaclaw` builds its
    // own routes and supplies the proxying implementation instead.
    Layer.provide(localWorkspaceRoutingLayer),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
