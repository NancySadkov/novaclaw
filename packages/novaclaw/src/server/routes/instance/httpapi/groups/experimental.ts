// F1f-prep: the route group declares only the WIRE schemas — no dependency on the V1 service file.
import { MCP } from "@/mcp"
import { Worktree } from "@/worktree"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"
import { Permission } from "@novaclaw/schema/permission"
import { ProjectFile } from "@novaclaw/schema/project-file"

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
/**
 * 🔴 **The refusable case, with its own STATUS — a client must be able to tell "confirm this" from
 * "this broke" without parsing an error name.**
 *
 * `409 Conflict` is the honest code: the request cannot be applied to the current state, and the
 * caller can make it applicable — here by retrying with `force`. A `400` says the request was
 * malformed, which this one is not.
 *
 * ⚠️ Split out on 2026-08-07 when `worktree remove` stopped destroying uncommitted work by default.
 * The refusal initially shared `WorktreeApiError`'s 400 envelope with genuine failures, so a UI could
 * not offer "delete anyway" without string-matching `name` — and the pre-2.0 surface it replaced had
 * `400 {forceRequired: true}`, a field clients keyed on. Losing that distinction is how a confirmable
 * refusal turns into an error message nobody can act on.
 */
export class WorktreeDirtyApiError extends Schema.ErrorClass<WorktreeDirtyApiError>("WorktreeDirtyError")(
  {
    name: Schema.Literal("WorktreeDirtyError"),
    data: Schema.Struct({
      directory: Schema.String,
      message: Schema.String,
      /** Machine-checkable "retry with force" — the affordance the pre-2.0 surface exposed. */
      forceRequired: Schema.Literal(true),
    }),
  },
  { httpApiStatus: 409 },
) {}

export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

/**
 * The resolved Project for the routed location.
 *
 * `todo/projects.md`: *"Never make a person infer project state from a hidden dotfile."* A
 * `novaclaw.json` can now narrow a session's permissions, so a user whose tool call is refused needs
 * somewhere to see WHICH file did it — and an agent asked to explain the refusal needs the same.
 */
export const ProjectState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    root: Schema.String,
    file: Schema.String,
    name: Schema.optional(Schema.String),
    /** How many permission rules the file contributes. The rules themselves are a separate surface. */
    permissionRules: Schema.Number,
    exclude: Schema.Array(Schema.String),
  }),
  /** Found and unusable. `reason` separates "your build is old" from "your file is broken". */
  Schema.Struct({
    kind: Schema.Literal("invalid"),
    file: Schema.String,
    reason: Schema.String,
    detail: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]).annotate({ identifier: "ProjectState" })

/**
 * What a write may supply. **Every section is optional and an absent one is LEFT ALONE.**
 *
 * `todo/projects.md`: *"create or update `novaclaw.json`, replacing only the sections supplied"*.
 * The server merges onto the file's RAW object, so a section this build has no type for survives an
 * edit untouched — which is why this schema names sections rather than accepting a whole document.
 *
 * ⚠️ There is deliberately no way to CLEAR a section here. An absent key and a cleared key would
 * have to be different values on the wire, and the only client today never clears one; offering an
 * ambiguous spelling of "delete my permissions" is worse than not offering it yet.
 */
export const ProjectWriteInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  permissions: Schema.optional(Permission.Ruleset),
  tune: Schema.optional(ProjectFile.Tune),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /** ⛔ IDs of installed policies only — never a command, and never anything the server runs. */
  policies: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ProjectWriteInput" })

/**
 * The receipt, or the refusal — both at **200**.
 *
 * 🔴 A refusal is not an error, and giving it an HTTP error status would be the second time this
 * feature made that mistake. `GET /api/project` already answers `200 {kind:"invalid"}` for a broken
 * file because "your project file is broken" is a state the UI renders calmly, next to the file's
 * path, with the detail the user needs to fix it. A write refused for the SAME reason, on the SAME
 * path, must not arrive as a 4xx that the app's fetch layer turns into a thrown `Error` — that is
 * how a calm explanation becomes a red toast saying "request failed".
 */
export const ProjectWriteResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    file: Schema.String,
    /** `true` when there was no file before — the receipt says "created" rather than "updated". */
    created: Schema.Boolean,
    /** The sections this write replaced. Everything else in the file is unchanged. */
    sections: Schema.Array(Schema.String),
    /**
     * Supervision switches the caller asked to record as OFF, which were dropped instead.
     *
     * A project file may raise a safety rail, never lower one, and absent means inherit. Reported so
     * the surface can say so rather than silently writing something different from what was asked.
     */
    refusedTune: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    file: Schema.String,
    /** `unreadable` · `not-an-object` · `future-version` · `would-not-parse` · `unwritable`. */
    reason: Schema.String,
    detail: Schema.String,
  }),
]).annotate({ identifier: "ProjectWriteResult" })

export const ExperimentalPaths = {
  // ⚠️ `/api/`, not `/experimental/`, and the ledger is what says so. `legacy-path-ledger.test.ts`
  // pins the non-`/api/*` set as SHRINK-ONLY (ruling 11: one contract, one generated artifact), so a
  // new route beside these neighbours is red — it typechecks, it works, and it reviews as consistent
  // with the file it sits in, which is exactly why the check is mechanical. `/api/diagnosis` and
  // `/api/capability` set the same precedent from this directory.
  project: "/api/project",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("project", ExperimentalPaths.project, {
          query: WorkspaceRoutingQuery,
          success: described(ProjectState, "The resolved Project for this location"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.state",
            title: "Resolved project",
            description:
              "The `novaclaw.json` governing this location: its root, validity and what it contributes. " +
              "A folder without one answers `none` and is perfectly usable.",
          }),
        ),
      )
      .add(
        // ⚠️ POST on the SAME path as the GET above, not a new `/experimental/*` sibling.
        // `legacy-path-ledger.test.ts` pins the non-`/api/*` set as shrink-only (ruling 11), so a
        // route added beside the `/experimental/…` neighbours in this file is red — it typechecks,
        // it works, and it reviews as consistent with the file it sits in.
        HttpApiEndpoint.post("projectWrite", ExperimentalPaths.project, {
          query: WorkspaceRoutingQuery,
          payload: ProjectWriteInput,
          success: described(ProjectWriteResult, "The receipt, or the refusal"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.write",
            title: "Write the project file",
            description:
              "Create or update this location's `novaclaw.json`, replacing ONLY the sections supplied and " +
              "preserving everything else — including sections this build does not understand. " +
              "Refuses, without writing, when an existing file does not parse.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          // Two error types: the refusable 409 and everything else. Only `remove` can be refused.
          error: [WorktreeApiError, WorktreeDirtyApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
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
