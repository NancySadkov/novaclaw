import { Location } from "@novaclaw/core/location"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { handlerLayer, VcsApi } from "@novaclaw/server/handler-api"
import { response } from "@novaclaw/server/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Vcs } from "@/project/vcs"

/**
 * **The VCS contract routes — declared in `packages/protocol`, served HERE.**
 *
 * 🔴 This file is why the five `/vcs*` legacy paths could finally go. The ledger recorded them as
 * blocked because `Vcs.Service` is novaclaw-internal, and that reasoning conflated two jobs:
 * `packages/protocol` declares the contract and could never import this package, but nothing ever
 * required the HANDLER to live next to the declaration. It lives here, beside the service, and
 * satisfies the group's type like any other handler layer. The only thing that had to move was the
 * wire shapes, which are pure `Schema` and now sit in `@novaclaw/schema/vcs`.
 */

/**
 * 🔴 **The instance context, taken here rather than supplied by middleware.**
 *
 * Every `Vcs.Interface` method reads `InstanceState.context`, which resolves `InstanceRef` — and the
 * `/api/**` runtime carries none. The legacy surface got one from `InstanceContextMiddleware`,
 * declared on the legacy API's own groups; a contract group cannot declare that middleware, because
 * it lives in this package and `packages/protocol` cannot see it. Pushing the middleware across that
 * boundary would make EVERY contract route load an instance merely by being called, so instead the
 * one family that needs the context takes it, for the location the request already named. Same
 * `store.load`, same directory, one family's cost.
 *
 * ⚠️ Measured, not guessed: without this the routes answered 500 "InstanceRef not provided", and
 * `httpapi-instance.test.ts` caught it the first time these handlers were mounted.
 */
const withInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const location = yield* Location.Service
    const ctx = yield* store.load({ directory: location.directory })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, location.workspaceID),
    )
  })

/** The service, scoped to the request's location. Resolved per request, never hoisted. */
const vcsFor = <A, E, R>(use: (vcs: Vcs.Interface) => Effect.Effect<A, E, R>) =>
  withInstance(
    Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      return yield* use(vcs)
    }),
  )

export const vcsHandlers = handlerLayer(
  HttpApiBuilder.group(VcsApi, "server.vcs", (handlers) =>
    handlers
      .handle(
        "vcs.get",
        Effect.fn("v2.vcs.get")(function* () {
          return yield* response(
            vcsFor((vcs) =>
              Effect.map(
                Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: "unbounded" }),
                ([branch, default_branch]) => ({ branch, default_branch }),
              ),
            ),
          )
        }),
      )
      .handle(
        "vcs.status",
        Effect.fn("v2.vcs.status")(function* () {
          return yield* response(vcsFor((vcs) => vcs.status()))
        }),
      )
      .handle(
        "vcs.diff",
        Effect.fn("v2.vcs.diff")(function* (ctx) {
          return yield* response(vcsFor((vcs) => vcs.diff(ctx.query.mode, { context: ctx.query.context })))
        }),
      )
      .handle(
        "vcs.diffRaw",
        Effect.fn("v2.vcs.diffRaw")(function* () {
          // No `Location` envelope: the body IS the patch, so a tool can apply the response directly.
          return yield* vcsFor((vcs) => vcs.diffRaw())
        }),
      )
      .handle(
        "vcs.apply",
        Effect.fn("v2.vcs.apply")(function* (ctx) {
          return yield* response(
            vcsFor((vcs) =>
              vcs.apply(ctx.payload).pipe(
                // `kind` carries the service's own reason, so a caller can still tell "you are not in
                // a repository" from "your tree has uncommitted changes" without a second error type.
                Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: error.reason })),
              ),
            ),
          )
        }),
      ),
  ),
)
