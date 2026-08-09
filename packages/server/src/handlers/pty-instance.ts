import { FSUtil } from "@novaclaw/core/fs-util"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { Pty } from "@novaclaw/core/pty"
import { Effect, RcMap } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PtyInstanceApi, handlerLayer } from "../handler-api"

const directoryFrom = (query: { readonly location?: { readonly directory?: string } }) =>
  FSUtil.resolve(query.location?.directory ?? process.cwd())

const listAt = Effect.gen(function* () {
  const location = yield* Location.Service
  const all = yield* (yield* Pty.Service).list()
  return all.map((data) => ({
    location: new Location.Info({
      directory: location.directory,
      workspaceID: location.workspaceID,
      root: location.root,
      origin: location.origin,
    }),
    data,
  }))
})

export const PtyInstanceHandler = handlerLayer(
  HttpApiBuilder.group(PtyInstanceApi, "server.pty-instance", (handlers) =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      const refsFor = (directory: string) =>
        RcMap.keys(locations.rcMap).pipe(
          Effect.map((refs) => Array.from(refs).filter((ref) => FSUtil.resolve(ref.directory) === directory)),
        )
      return handlers
        .handle(
          "pty.instanceList",
          Effect.fn("PtyInstanceHandler.list")(function* (ctx) {
            const refs = yield* refsFor(directoryFrom(ctx.query))
            const nested = yield* Effect.forEach(refs, (ref) => listAt.pipe(Effect.provide(locations.get(ref))), {
              concurrency: "unbounded",
            })
            return nested.flat()
          }),
        )
        .handle(
          "pty.instanceRemoveAll",
          Effect.fn("PtyInstanceHandler.removeAll")(function* (ctx) {
            const refs = yield* refsFor(directoryFrom(ctx.query))
            const counts = yield* Effect.forEach(
              refs,
              (ref) => Pty.Service.use((pty) => pty.removeAll()).pipe(Effect.provide(locations.get(ref))),
              { concurrency: "unbounded" },
            )
            return counts.reduce((total, count) => total + count, 0)
          }),
        )
    }),
  ),
)
