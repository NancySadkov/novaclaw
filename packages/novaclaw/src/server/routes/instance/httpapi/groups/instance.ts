import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  data: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
  roots: Schema.Array(Schema.String),
  // FS-3: when true the host exposes no browsable FS — the picker/Files use `virtualRoot`
  // (an app-private directory) instead of `roots`. Optional so old clients ignore it.
  virtual: Schema.optional(Schema.Boolean),
  virtualRoot: Schema.optional(Schema.String),
  // The shared default working directory for folder-less agents ("New Agent" with no project).
  // A real app-managed dir under `<data>/scratch`; the client uses it as the cwd when no folder
  // is picked. Optional so old clients ignore it.
  scratchDir: Schema.optional(Schema.String),
  // The instance host's existing well-known user folders (+ Linux GTK bookmarks) — the
  // directory-picker's "Places" rail. Existence-checked server-side; suppressed in virtual
  // mode. Optional so old clients ignore it.
  places: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))),
  // The remaining storage locations, surfaced so Settings can SHOW a user where their instance keeps
  // things (Advanced+). Not needed to operate the app, which is why they are optional — but a user who
  // wants to back up, inspect or delete an instance should never have to guess, and "where is the
  // database?" was unanswerable from the UI. `db` in particular is channel-dependent
  // (`novaclaw.db` on prod, `novaclaw-<channel>.db` otherwise), so it cannot be derived client-side.
  cache: Schema.optional(Schema.String),
  tmp: Schema.optional(Schema.String),
  log: Schema.optional(Schema.String),
  db: Schema.optional(Schema.String),
  // Set only when this instance was pinned with `--home`/NOVACLAW_HOME, so the UI can say plainly
  // that it is running out of one folder rather than the shared per-user locations.
  instanceHome: Schema.optional(Schema.String),
}).annotate({ identifier: "Path" })

// The persisted home-app registry (B14). Manifests are LAUNCHERS (route/URL/prompt), not code;
// the store is global (Global.Path.data/apps) — `directory` on these endpoints is only routing.
const AppManifest = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  icon: Schema.optional(Schema.String),
  accent: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  open: Schema.Struct({ type: Schema.Literals(["route", "url", "prompt"]), value: Schema.String }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "AppManifest" })

const AppRegisterPayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  title: Schema.String,
  icon: Schema.optional(Schema.String),
  accent: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  open: Schema.Struct({ type: Schema.Literals(["route", "url", "prompt"]), value: Schema.String }),
})

export class ApiAppRegisterError extends Schema.ErrorClass<ApiAppRegisterError>("AppRegisterError")(
  {
    name: Schema.Literal("AppRegisterError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

// The live scheduler view — the `ps`-app story the EEVDF ledger's own snapshot() was written for:
// ONE query surface over the running session world, shared by humans, agents and tests.
const SchedulerLedgerEntry = Schema.Struct({
  id: Schema.String,
  weight: Schema.Number,
  sliceTokens: Schema.Number,
  lag: Schema.Number,
  vdeadline: Schema.Number,
})
const SchedulerDevice = Schema.Struct({
  deviceKey: Schema.String,
  inFlightInteractive: Schema.Array(Schema.String),
  inFlightBatch: Schema.Array(Schema.String),
  waiting: Schema.Array(Schema.String),
  ledger: Schema.Array(SchedulerLedgerEntry),
})

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  formatter: "/formatter",
  app: "/app",
  scheduler: "/scheduler/snapshot",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current NovaClaw instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the NovaClaw instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the NovaClaw system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the NovaClaw system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the NovaClaw system.",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
        HttpApiEndpoint.get("scheduler", InstancePaths.scheduler, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SchedulerDevice), "Live scheduler state, one entry per device"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.scheduler",
            summary: "Scheduler snapshot",
            description: "Per-device in-flight and waiting sessions plus the EEVDF ledger — the live `ps` view.",
          }),
        ),
        HttpApiEndpoint.get("appList", InstancePaths.app, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AppManifest), "Persisted home-app manifests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.list",
            summary: "List home apps",
            description: "List persisted home-app manifests (agent- or user-registered launchers).",
          }),
        ),
        HttpApiEndpoint.post("appRegister", InstancePaths.app, {
          query: WorkspaceRoutingQuery,
          payload: AppRegisterPayload,
          success: described(AppManifest, "The persisted manifest"),
          error: ApiAppRegisterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.register",
            summary: "Register a home app",
            description: "Register (or update, by id) a home-app manifest: a launcher tile opening a route, URL, or chat prompt.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
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
