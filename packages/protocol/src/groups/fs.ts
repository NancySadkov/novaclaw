import { FileSystem } from "@novaclaw/schema/filesystem"
import { Location } from "@novaclaw/schema/location"
import { Ticket, TICKET_QUERY } from "@novaclaw/schema/ticket"
import { PositiveInt, RelativePath } from "@novaclaw/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const FS_READ_PATH_PREFIX = "/api/fs/read/"

const FS_READ_PATH = /^\/api\/fs\/read\/./

/**
 * The file a `/api/fs/read/*` URL names, relative to its location — the wildcard segment, decoded.
 *
 * 🔴 **One reader, because the ticket's scope is only sound if the MINT, the ADMISSION and the READ
 * all name the same file.** They live in three files (`handlers/fs.ts` twice and
 * `middleware/authorization.ts`); the handler used to slice the pathname at a hand-written `13`,
 * and a second hand-written offset elsewhere is how a ticket minted for `a.txt` comes to authorize
 * `b.txt`. Returns `undefined` for anything that is not this route, so a caller cannot mistake "no
 * path" for the empty path.
 */
export function fileReadPath(url: URL): string | undefined {
  if (!FS_READ_PATH.test(url.pathname)) return undefined
  try {
    return decodeURIComponent(url.pathname.slice(FS_READ_PATH_PREFIX.length))
  } catch {
    // A malformed percent-escape is not a path. The handler answers 404 rather than throwing, and
    // the middleware must not admit a request it cannot name.
    return undefined
  }
}

/**
 * A `/api/fs/read/*` request presenting a ticket.
 *
 * 🔴 **Presenting one is NOT being authorized by one.** The authorization middleware skips the
 * credential check when this matches — exactly as it does for `hasPtyConnectTicketURL` — and the
 * `fs.read` handler is then obliged to CONSUME the ticket and refuse the request when it does not
 * match the file being asked for. A handler that forgot would turn this predicate into an open
 * door: `?ticket=anything` would read any file on the host.
 */
export function hasFileReadTicketURL(url: URL) {
  return fileReadPath(url) !== undefined && !!url.searchParams.get(TICKET_QUERY)
}

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

const SnapshotReadQuery = Schema.Struct({
  ...LocationQuery.fields,
  snapshot: Schema.String,
  path: RelativePath,
})

const ReadTokenQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath,
})

export const DirectoryBrowseEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["file", "directory"]),
})

/**
 * Host browsing is deliberately NOT location-scoped. A directory shown in a picker is not an agent
 * workspace, and listing it must not boot the location kernel merely to obtain direct child names.
 */
export const DirectoryBrowseGroup = HttpApiGroup.make("server.directory-browse")
  .add(
    HttpApiEndpoint.get("directory.browse", "/api/directory/browse", {
      query: Schema.Struct({ directory: Schema.String }),
      success: Schema.Array(DirectoryBrowseEntry),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.directory.browse",
        summary: "Browse a host directory",
        description: "List direct file and folder names without booting a project or agent location for the directory.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "directory", description: "Host directory browsing." }))

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: ForbiddenError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description:
            "Serve one file relative to the requested location. A browser download presents a `ticket` " +
            "from `fs.readToken` in place of the `Authorization` header it cannot set.",
          transform: (operation) => ({
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              { in: "query", name: TICKET_QUERY, schema: { type: "string" } },
            ],
          }),
        }),
      ),
  )
  .add(
    /**
     * 🔴 **Minted at CLICK time, and that is the whole design.** The rendered chat is
     * content-addressed and replayed from a 200-entry LRU while `fs.read` sets no cache headers, so
     * a ticket baked into markup is spent on the first paint and 401s on the second; and a download
     * anchor is clicked at an arbitrary later moment, so any TTL short enough to be a ticket is
     * already gone. A click handler mints, hands the browser the URL and lets it STREAM — which is
     * also why this is not the image half's answer: a large artefact must never fit in a JS string.
     */
    HttpApiEndpoint.post("fs.readToken", "/api/fs/read-token", {
      query: ReadTokenQuery,
      success: Location.response(Ticket.AccessToken),
      error: ForbiddenError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.readToken",
          summary: "Create file read ticket",
          description: "Create a short-lived single-use ticket authorizing one browser download of one file.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.snapshotRead", "/api/fs/snapshot/read", {
      query: SnapshotReadQuery,
      success: Location.response(FileSystem.SnapshotContent),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.snapshotRead",
          summary: "Read snapshot file",
          description: "Read one file exactly as it existed in a captured session revision.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
