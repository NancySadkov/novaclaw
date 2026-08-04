import { EffectBridge } from "@/effect/bridge"
import { registerDisposer } from "@/effect/instance-registry"
import { ServerLocationServiceMap } from "@/location-service-map"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Effect, Layer } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/unstable/http"

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

// Disposal is requested by an endpoint handler, but must run from the outer
// server middleware after the response has been produced. The original Request
// object is the stable handoff key between those two phases.
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

/**
 * Release a directory's LOCATION layer graph when its instance is disposed.
 *
 * `InstanceStore.dispose`/`reload`/`disposeAll` fan out through the process-wide disposer set
 * (`@/effect/instance-registry`), which is keyed only by directory. The `LayerMap` behind
 * `LocationServiceMap` is the one cache whose entry outlives that fan-out on its own — its idle TTL
 * is 60 minutes — so without this registration a disposed or RELOADED instance keeps serving its old
 * location graph even after `InstanceStore.reload` resolves different location metadata.
 *
 * ⚠️ **It lives here, and not in a handler group, because it is not about any route.** It used to be
 * registered inside `handlers/pty.ts` — twice, once per pty group — which made "an instance disposal
 * actually releases its location" contingent on the **Terminal** routes having been constructed in
 * this process. Every dispose path (the explicit `/instance` endpoint, direct instance reloads, server
 * shutdown) depends on it, and none of them has anything to do with a pty. `createRoutes` merges
 * this layer directly, so it is built for every assembly that serves routes at all.
 *
 * ⚠️ It self-provides `ServerLocationServiceMap.layer` — the SAME module-level layer object every
 * handler group provides and that `createRoutes` provides twice more. Effect memoizes a layer by
 * that inner reference within one memo map, so this adds a consumer, never a second map (the
 * one-map-per-server invariant in `@/location-service-map`; AGENTS.md → Known pitfalls, item −1).
 */
export const locationDisposerLayer: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const unregister = registerDisposer((directory) =>
      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.logWarning("instance disposal failed", { cause })),
    )
    return response
  })
