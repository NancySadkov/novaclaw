import { FileSystem } from "@novaclaw/core/filesystem"
import { NonNegativeInt } from "@novaclaw/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
})

export const FindTextQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  pattern: Schema.String,
})

export const FindFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
  dirs: Schema.optional(Schema.Literals(["true", "false"])),
  type: Schema.optional(Schema.Literals(["file", "directory"])),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})

export const LegacyMatch = Schema.Struct({
  path: Schema.Struct({ text: Schema.String }),
  lines: Schema.Struct({ text: Schema.String }),
  line_number: NonNegativeInt,
  absolute_offset: NonNegativeInt,
  submatches: Schema.Array(
    Schema.Struct({
      match: Schema.Struct({ text: Schema.String }),
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})

export const LegacyEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
}).annotate({ identifier: "FileNode" })

export const LegacyContent = Schema.Struct({
  // "missing" = the path does not exist. It USED to masquerade as {type:"text",content:""},
  // which made absent and empty indistinguishable for every consumer (issues.md P2 — this
  // silently poisoned the Notes create flow's existence check).
  type: Schema.Literals(["text", "binary", "missing"]),
  content: Schema.String,
  diff: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({
      oldFileName: Schema.String,
      newFileName: Schema.String,
      oldHeader: Schema.optional(Schema.String),
      newHeader: Schema.optional(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          oldStart: NonNegativeInt,
          oldLines: NonNegativeInt,
          newStart: NonNegativeInt,
          newLines: NonNegativeInt,
          lines: Schema.Array(Schema.String),
        }),
      ),
      index: Schema.optional(Schema.String),
    }),
  ),
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "FileContent" })

export const LegacyStatus = Schema.Struct({
  path: Schema.String,
  added: NonNegativeInt,
  removed: NonNegativeInt,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "File" })

// FS-1b write half (M4): write/mkdir + the safe-delete trash trio. Payload paths are RELATIVE to
// the routed directory (same contract as `path` on list/content); the handler enforces
// FSUtil.contains so nothing escapes the browsed root.
export const WritePayload = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
})

export const MkdirPayload = Schema.Struct({
  path: Schema.String,
})

export const TrashPayload = Schema.Struct({
  path: Schema.String,
})

export const TrashRestorePayload = Schema.Struct({
  id: Schema.String,
})

export const TrashEntry = Schema.Struct({
  id: Schema.String,
  originalPath: Schema.String,
  trashedAt: Schema.Number,
  type: Schema.Literals(["file", "directory"]),
}).annotate({ identifier: "TrashEntry" })

export const OkResult = Schema.Struct({ ok: Schema.Literal(true) })

export const RestoreResult = Schema.Struct({ restoredPath: Schema.String })

export const FilePaths = {
  findText: "/find",
  findFile: "/find/file",
  list: "/file",
  content: "/file/content",
  status: "/file/status",
  write: "/file/content",
  mkdir: "/file/mkdir",
  trash: "/file/trash",
  trashList: "/file/trash",
  trashRestore: "/file/trash/restore",
} as const

export const FileApi = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("findText", FilePaths.findText, {
          query: FindTextQuery,
          success: described(Schema.Array(LegacyMatch), "Matches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.text",
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
          }),
        ),
        HttpApiEndpoint.get("findFile", FilePaths.findFile, {
          query: FindFileQuery,
          success: described(Schema.Array(Schema.String), "File paths"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.files",
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("list", FilePaths.list, {
          query: FileQuery,
          success: described(Schema.Array(LegacyEntry), "Files and directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", FilePaths.content, {
          query: FileQuery,
          success: described(LegacyContent, "File content"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.get("status", FilePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LegacyStatus), "File status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
        HttpApiEndpoint.put("write", FilePaths.write, {
          query: WorkspaceRoutingQuery,
          payload: WritePayload,
          success: described(OkResult, "File written"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.write",
            summary: "Write file",
            description: "Write text content to a file under the routed directory (parents created).",
          }),
        ),
        HttpApiEndpoint.post("mkdir", FilePaths.mkdir, {
          query: WorkspaceRoutingQuery,
          payload: MkdirPayload,
          success: described(OkResult, "Directory created"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.mkdir",
            summary: "Create directory",
            description: "Create a directory (recursive) under the routed directory.",
          }),
        ),
        HttpApiEndpoint.post("trash", FilePaths.trash, {
          query: WorkspaceRoutingQuery,
          payload: TrashPayload,
          success: described(TrashEntry, "Trashed entry"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.trash",
            summary: "Trash file or directory",
            description: "Safe-delete: move a file or directory into the dated Trash store (restorable, TTL ~2 days).",
          }),
        ),
        HttpApiEndpoint.get("trashList", FilePaths.trashList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(TrashEntry), "Trash entries"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.trash.list",
            summary: "List trash",
            description: "List trashed entries, newest first (expired entries are purged lazily).",
          }),
        ),
        HttpApiEndpoint.post("trashRestore", FilePaths.trashRestore, {
          query: WorkspaceRoutingQuery,
          payload: TrashRestorePayload,
          success: described(RestoreResult, "Restored path"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.trash.restore",
            summary: "Restore from trash",
            description: "Restore a trashed entry to its original path (collision-safe suffix if occupied).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "Experimental HttpApi file routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "novaclaw experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
