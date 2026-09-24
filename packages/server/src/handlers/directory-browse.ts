export * as DirectoryBrowse from "./directory-browse"

import fs from "node:fs/promises"
import path from "node:path"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DirectoryBrowseApi, handlerLayer } from "../handler-api"

export type Entry = { readonly name: string; readonly type: "file" | "directory" }

/** One validation and one flat `readdir`; a picker directory is not an agent location. */
export async function list(directory: string): Promise<Entry[]> {
  if (!path.isAbsolute(directory)) throw new Error("That folder path is not absolute")
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return entries
    .flatMap((entry): Entry[] => {
      if (entry.isDirectory()) return [{ name: entry.name, type: "directory" }]
      if (entry.isFile()) return [{ name: entry.name, type: "file" }]
      return []
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
}

export const DirectoryBrowseHandler = handlerLayer(
  HttpApiBuilder.group(DirectoryBrowseApi, "server.directory-browse", (handlers) =>
    Effect.gen(function* () {
      return handlers.handle(
        "directory.browse",
        Effect.fn("DirectoryBrowse.list")(function* (ctx: { readonly query: { readonly directory: string } }) {
          return yield* Effect.tryPromise({
            try: () => list(ctx.query.directory),
            catch: (error) =>
              new InvalidRequestError({
                message: error instanceof Error ? error.message : "That folder could not be read",
              }),
          })
        }),
      )
    }),
  ),
)
