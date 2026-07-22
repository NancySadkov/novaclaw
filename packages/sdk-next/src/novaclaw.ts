import { NovaClaw } from "@novaclaw/client/effect"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { createEmbeddedRoutes } from "@novaclaw/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export const create = Effect.fn("NovaClaw.create")(function* () {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    Layer.mergeAll(ApplicationTools.layer, PermissionSaved.defaultLayer, CatalogStore.defaultLayer),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const catalogStore = Context.get(context, CatalogStore.Service)
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        createEmbeddedRoutes().pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(PermissionSaved.Service, permissions),
              Layer.succeed(CatalogStore.Service, catalogStore),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  // `createEmbeddedRoutes` provides every handler service internally (its `serviceLayer` builds
  // Database/EventV2/SessionV2/Credential/Messenger*/… — all of them), so this web handler is
  // fully self-contained: at runtime `handler(request)` resolves each service from the router's
  // own built context (the second `context` arg is optional and merged in only when present).
  // effect's request-scope typing, though, doesn't count those build-scope provides as satisfying
  // the instance-global handlers (messenger, credential, event) that read services per request, so
  // `web.handler` types as the "needs a Context" branch. Assert the truth — that no external
  // context is needed. We must NOT provide fresh layers to satisfy the type: that would build a
  // SECOND Database/MessengerGateway (two long-polls on one account, edge #16).
  const handler = web.handler as (request: globalThis.Request) => Promise<Response>
  const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
    preconnect: () => undefined,
  }) satisfies typeof globalThis.fetch
  const client = yield* NovaClaw.make({ baseUrl: "http://novaclaw.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@novaclaw/sdk-next/NovaClaw") {}

export const layer = Layer.effect(Service, create())
