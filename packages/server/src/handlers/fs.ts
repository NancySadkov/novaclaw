import { FileSystem } from "@novaclaw/core/filesystem"
import { Snapshot } from "@novaclaw/core/snapshot"
import { RelativePath } from "@novaclaw/core/schema"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const file = yield* (yield* FileSystem.Service).read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.snapshotRead", (ctx) =>
        response(
          Effect.gen(function* () {
            const result = yield* (yield* Snapshot.Service)
              .read({
                snapshot: Snapshot.ID.make(ctx.query.snapshot),
                path: RelativePath.make(ctx.query.path),
              })
              .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
            return {
              type: "binary" as const,
              content: Buffer.from(result.content).toString("base64"),
              encoding: "base64" as const,
              mimeType: result.mime,
            }
          }),
        ),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
  }),
)
