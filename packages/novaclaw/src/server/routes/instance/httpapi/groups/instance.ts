import { Agent } from "@/agent/agent"
import { Command } from "@/command"
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
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
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

export // The live scheduler view — the `ps`-app story the EEVDF ledger's own snapshot() was written for:
// ONE query surface over the running session world, shared by humans, agents and tests.
const SchedulerLedgerEntry = Schema.Struct({
  id: Schema.String,
  weight: Schema.Finite,
  sliceTokens: Schema.Finite,
  lag: Schema.Finite,
  vdeadline: Schema.Finite,
})
const SchedulerDevice = Schema.Struct({
  deviceKey: Schema.String,
  concurrency: Schema.Int,
  locality: Schema.Literals(["local", "lan", "remote"]).pipe(Schema.optional),
  inFlightInteractive: Schema.Array(Schema.String),
  inFlightBatch: Schema.Array(Schema.String),
  waiting: Schema.Array(Schema.String),
  ledger: Schema.Array(SchedulerLedgerEntry),
})

/**
 * Nova Health — ONE composed answer to *"is anything wrong?"*, from readings that already exist.
 *
 * The composition itself is `NovaHealth` in core: pure, no I/O, no clock. This endpoint is the
 * caller that gathers the readings, which is exactly what keeps the expensive one honest.
 *
 * ⚠️ **Reachability costs egress, so it is never part of opening the screen.** `?probe=provider` is
 * an explicit opt-in; without it the provider row says it has not looked, which is true. A
 * diagnostics page that phones out every time someone glances at it is a worse citizen than one that
 * admits it has not looked. The board speaks for ONE provider — the default model's — because
 * "can I talk to my model?" is a singular question and probing a dozen configured providers would
 * multiply the only expensive reading to answer something nobody asked.
 *
 * ⚠️ `unknown` is a first-class verdict here and must never render as a tick. Half of these signals
 * can legitimately answer "cannot tell" — a pressure probe reports `unknown` rather than guessing.
 * This is the one screen a person opens
 * when they already suspect something is broken; dressing an unread probe as healthy is ruling 2.
 */
const DiagnosisStatus = Schema.Literals(["problem", "warning", "unknown", "ok"])

const DiagnosisSignal = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: DiagnosisStatus,
  detail: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
})

const Diagnosis = Schema.Struct({
  overall: DiagnosisStatus,
  headline: Schema.String,
  signals: Schema.Array(DiagnosisSignal),
})

const DiagnosisQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** `provider` opts INTO the one reading that egresses. Absent means "do not contact anyone". */
  probe: Schema.optional(Schema.Literals(["provider"])),
})

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  command: "/command",
  agent: "/agent",
  app: "/app",
  scheduler: "/scheduler/snapshot",
  // ⚠️ `/api/` — ruling 11's ONE contract prefix. Every sibling in this map is a LEGACY path pinned
  // in `legacy-path-ledger.test.ts` (a list that may only shrink); `/diagnosis` was added here after
  // that ledger was frozen and inherited the legacy shape by proximity. The ledger could not object,
  // because `openapi.json` had gone stale and the spec it reads never showed the new route.
  diagnosis: "/api/diagnosis",
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
        HttpApiEndpoint.get("diagnosis", InstancePaths.diagnosis, {
          query: DiagnosisQuery,
          success: described(Diagnosis, "One composed answer to whether anything is wrong"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.diagnosis",
            summary: "Diagnose this instance",
            description:
              "Compose storage, conversation store, memory, scheduler, updater and provider readings into one " +
              "verdict. " +
              "Nothing costs egress unless probe=provider is passed, so opening a diagnostics screen never contacts anyone.",
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
            description:
              "Register (or update, by id) a home-app manifest: a launcher tile opening a route, URL, or chat prompt.",
          }),
        ),
        // ⚠️ Removing an app lives on the /api/* contract (`protocol/groups/app.ts`), NOT here.
        // This group is the LEGACY surface, pinned shrink-only by ruling 11, and adding `/app/:id`
        // grew it — `sdk-js`'s legacy-path ledger caught it immediately and named the remedy.
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
