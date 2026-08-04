export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Duration, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@novaclaw/schema/session"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
// Ruling 8: a fork is seeded from the source's chain-RESOLVED config, never its raw row.
import { forkSessionConfig } from "./session/config-resolve"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@novaclaw/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import path from "path"
import { fromRow } from "./session/info"
import { JhStore } from "./jh/store"
import { SessionRunner } from "./session/runner/index"
import { SessionScheduler } from "./session/scheduler"
import { SessionStore } from "./session/store"
import { SessionCompactionRequest } from "./session/compaction-request"
import { SessionExecution } from "./session/execution"
import { SessionRunCoordinator } from "./session/run-coordinator"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionMessageRead } from "./session/message-read"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { SessionPatch } from "./session/patch"
import { SessionTitle } from "./session/title"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { Revert } from "@novaclaw/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@novaclaw/schema/durable-event-manifest"
import { Config } from "./config"
import { CommandV2 } from "./command"
import { ExternalCommandSource } from "./command/external-command-source"
import { SkillCommand } from "./command/skill-command"
import { SkillV2 } from "./skill"
import { SessionRead } from "./session/read"
import { SessionSpawner } from "./session/spawner"
import { SessionTodo } from "./session/todo"
import { AppProcess } from "./process"
import { Shell } from "./shell"
import { ChildProcess } from "effect/unstable/process"
import { Identifier } from "./id/id"

// The V2 `shell` op caps captured output at the same 1 MB in-memory limit the bash tool uses.
const SHELL_MAX_OUTPUT_BYTES = 1024 * 1024

// Argument tokenizer + placeholder matchers for slash-command templates (ported from the V1
// SessionPrompt.command path). `$1`..`$N` are positional, the highest-numbered placeholder
// soaks up all trailing args, and `$ARGUMENTS` is the whole raw string.
const COMMAND_ARGS_REGEX = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const COMMAND_PLACEHOLDER_REGEX = /\$(\d+)/g
const COMMAND_QUOTE_TRIM_REGEX = /^["']|["']$/g
// `` !`cmd` `` inline shell substitution in a command template — each match's output replaces it.
const COMMAND_BASH_REGEX = /!`([^`]+)`/g

/**
 * Expand a slash-command template against a raw argument string: substitute `$1`..`$N`
 * (the highest placeholder receives all remaining args) and `$ARGUMENTS`; when the template
 * has no placeholders at all, append the raw arguments. Pure + exported for direct testing.
 * (Residue vs the V1 path: `` !`shell` `` command substitution, agent/model override, and the
 * subtask branch are not yet handled here — see todo.md F1a SLICE 5.)
 */
export function expandCommandTemplate(template: string, argumentsRaw: string): string {
  const raw = argumentsRaw.match(COMMAND_ARGS_REGEX) ?? []
  const args = raw.map((arg) => arg.replace(COMMAND_QUOTE_TRIM_REGEX, ""))
  const placeholders = template.match(COMMAND_PLACEHOLDER_REGEX) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }
  const withArgs = template.replaceAll(COMMAND_PLACEHOLDER_REGEX, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    return position === last ? args.slice(argIndex).join(" ") : args[argIndex]
  })
  const usesArgumentsPlaceholder = template.includes("$ARGUMENTS")
  let out = withArgs.replaceAll("$ARGUMENTS", argumentsRaw)
  if (placeholders.length === 0 && !usesArgumentsPlaceholder && argumentsRaw.trim()) out = out + "\n\n" + argumentsRaw
  return out.trim()
}

export const RevertState = Revert.State
export type RevertState = Revert.State

// get all sessions
//
// - by directory (exact) or under a root (boundary prefix)
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
  /** Only root sessions (no parent) — the threads-tree top level (V1-nuke: the V1 list's filter). */
  roots: Schema.Boolean.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

// T2 (notes/entities.md): "a project's sessions" is an entity-free query — every session whose
// directory IS the root or lives under it (boundary-exact, both separators).
const ListUnderInput = Schema.Struct({
  ...ListInputBase,
  under: AbsolutePath,
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListUnderInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  systemPromptOverride?: string
  type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  priority?: number
  permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  // Who answers this session; `sessionRow` has always written the column, but until 2026-07-29 no
  // create path could supply one, so the only writer was `SessionEvent.ResponderSwitched`.
  responder?: SessionSchema.Info["responder"]
  // The per-session Strict-harness override (the composer switch); undefined = inherit.
  strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number }
  // Per-session harness-feature overrides (the composer's Tuning control); undefined = inherit.
  introspection?: boolean
  quality?: boolean
  affective?: boolean
  thinkingBudget?: SessionSchema.Info["thinkingBudget"]
  // ⚠️ RESTRICTIONS. Until 2026-07-29 `sessionRow` dropped these two (and `thinkingBudget`) on the
  // floor, so a create meaning to restrict a session silently produced an unrestricted one.
  surgicalEdits?: boolean
  askBeforeChanges?: boolean
  // SAFE MODE (owner 2026-07-30) — also a RESTRICTION: it puts an unattended chain's host execution
  // back behind sandbox confinement, and refuses on a host with no backend.
  safeMode?: boolean
  contextBudget?: boolean
  location: Location.Ref
  // F1c fork: a fork seeds its record from the source (title + cloned metadata).
  title?: string
  metadata?: Record<string, unknown>
  // F1c create: the caller's explicit saved ruleset. Deliberately NOT merged with the
  // permission-mode overlay here (V1 baked MODE_RULES into the saved rules at create; the V2
  // runner applies the overlay from `permissionMode` at runtime, so baking would make the
  // create-time mode stick across later mode switches).
  permission?: PermissionRuleset.Ruleset
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

type CommandInput = {
  sessionID: SessionSchema.ID
  command: string
  arguments: string
  id?: SessionMessage.ID
}

// A command either submits its expanded template as a prompt to THIS session, or — when it
// resolves to a subagent (agent.mode "subagent" or cmd.subtask) — spawns a CHILD session that
// runs it. The two dispatch paths return different things, so `command` is a discriminated union.
type CommandResult =
  | { readonly type: "prompt"; readonly admitted: SessionInput.Admitted }
  | { readonly type: "subtask"; readonly childID: SessionSchema.ID }

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly switchResponder: (input: {
    sessionID: SessionSchema.ID
    responder: "nova" | "operator"
  }) => Effect.Effect<void, NotFoundError>
  readonly switchMode: (input: {
    sessionID: SessionSchema.ID
    permissionMode: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  }) => Effect.Effect<void, NotFoundError>
  readonly switchStrict: (input: {
    sessionID: SessionSchema.ID
    strict: { enabled?: boolean; attempts?: number; wallMinutes?: number } | null
  }) => Effect.Effect<void, NotFoundError>
  readonly switchFeature: (input: {
    sessionID: SessionSchema.ID
    feature:
      | "introspection"
      | "quality"
      | "affective"
      | "thinkingBudget"
      | "surgicalEdits"
      | "askBeforeChanges"
      | "safeMode"
      | "contextBudget"
    enabled: boolean | null
  }) => Effect.Effect<void, NotFoundError>
  readonly switchType: (input: {
    sessionID: SessionSchema.ID
    type: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  }) => Effect.Effect<void, NotFoundError>
  readonly switchPromptOverride: (input: {
    sessionID: SessionSchema.ID
    override: string | null
  }) => Effect.Effect<void, NotFoundError>
  readonly setTitle: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: Record<string, unknown>
  }) => Effect.Effect<void, NotFoundError>
  readonly setArchived: (input: { sessionID: SessionSchema.ID; time?: number }) => Effect.Effect<void, NotFoundError>
  readonly setPermission: (input: {
    sessionID: SessionSchema.ID
    permission: PermissionRuleset.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  readonly children: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info[], NotFoundError>
  /** The agent-maintained todo list (native twin of the retired bare-/session read — V1-nuke A0). */
  readonly todos: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionTodo.Info>, NotFoundError>
  readonly fork: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | MessageDecodeError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<SessionMessage.ID, NotFoundError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly command: (input: CommandInput) => Effect.Effect<CommandResult, NotFoundError | PromptConflictError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Session") {}

/**
 * Create a session RECORD — persist the project row + publish `Created` (the projector writes the
 * session table) — from CYCLE-FREE primitives only (no `LocationServiceMap`/execution). Shared by
 * `SessionV2.create` and the `SessionSpawner` seam (architecture.md Phase 3 step 6): spawn reuses
 * create WITHOUT depending on `SessionV2.node`, which would close the runner cycle
 * `SessionV2 -> LocationServiceMap -> location services -> spawn -> SessionV2`.
 */
export const createSessionRecord = (
  deps: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly projects: ProjectV2.Interface
    readonly store: SessionStore.Interface
  },
  input: CreateInput,
) =>
  Effect.gen(function* () {
    const { db, events, projects, store } = deps
    const sessionID = input.id ?? SessionSchema.ID.create()
    const recorded = yield* store.get(sessionID)
    if (recorded) return recorded
    const project = yield* projects.resolve(input.location.directory)
    const now = Date.now()
    const subpath = path.relative(project.directory, input.location.directory).replaceAll("\\", "/")
    const info = SessionSchema.Info.make({
      id: sessionID,
      parentID: input.parentID,
      slug: Slug.create(),
      version: InstallationVersion,
      location: Location.Ref.make({
        directory: input.location.directory,
        workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
      }),
      subpath: subpath ? RelativePath.make(subpath) : undefined,
      // Bare default — no ISO suffix (a raw timestamp in the chat header is machine noise; the
      // Chats list shows relative time). SessionTitle.isDefault matches this AND the old form.
      title: input.title ?? "New session",
      metadata: input.metadata,
      agent: input.agent,
      model: input.model
        ? {
            id: ModelV2.ID.make(input.model.id),
            providerID: input.model.providerID,
            variant: ModelV2.VariantID.make(input.model.variant ?? "default"),
          }
        : undefined,
      systemPromptOverride: input.systemPromptOverride,
      type: input.type,
      priority: input.priority,
      permission: input.permission ? [...input.permission] : undefined,
      permissionMode: input.permissionMode,
      responder: input.responder,
      strict: input.strict,
      introspection: input.introspection,
      quality: input.quality,
      affective: input.affective,
      thinkingBudget: input.thinkingBudget,
      surgicalEdits: input.surgicalEdits,
      askBeforeChanges: input.askBeforeChanges,
      safeMode: input.safeMode,
      contextBudget: input.contextBudget,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
    })
    const projected = yield* events
      .publish(SessionRecordEvent.Created, { sessionID, info }, { location: input.location })
      .pipe(
        Effect.as({ type: "created" } as const),
        Effect.catchDefect((defect) => {
          if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
            return Effect.die(defect)
          }
          // Concurrent creation lost the projection race. The existing Session identity wins.
          return store
            .get(sessionID)
            .pipe(
              Effect.flatMap((session) =>
                session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
              ),
            )
        }),
      )
    if (projected.type === "existing") return projected.session
    // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
    const created = yield* store.get(sessionID)
    if (!created) return yield* Effect.die(new NotFoundError({ sessionID }))
    return created
  })

/**
 * Remove a session RECORD tree from CYCLE-FREE primitives (the `createSessionRecord` seam
 * pattern): run the injected `interrupt` first (the SessionV2 layer passes the execution
 * coordinator; the workspace control-plane's session sweep has none — matching the V1 remove
 * it replaces there), then the injected `evict`, depth-first over children, publish the
 * full-info legacy `session.deleted` (its projector row-delete cascades
 * messages/parts/todos/tags via FK), then purge the aggregate's event log.
 *
 * `evict` follows `interrupt` exactly: an OPTIONAL injected primitive, because the seam must
 * stay usable by the service-less callers (the CLI's `session delete` holds no scheduler at
 * all — its ledger dies with the process). Where a scheduler DOES exist it drops the removed
 * session's entry AT ONCE, along with any slot a hard kill left it holding — the gate's own
 * forgiveness-TTL retention would eventually reclaim the entry, but not the slot, and not now.
 *
 * The jh purge is NOT optional and takes no injection: `jh_plan`/`jh_log`/`jh_artifact` carry no
 * FK to the session table (engine-internal, D10), so the `session.deleted` projector's row-delete
 * cascade never reached them and a deleted chat left its Strict plans, logs and artifact CONTENT
 * on disk forever. It runs BEFORE the delete publish so a store fault aborts the removal instead
 * of reporting success over a half-deleted session.
 */
export const removeSessionRecord = (
  deps: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly interrupt?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
    readonly evict?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  },
  sessionID: SessionSchema.ID,
): Effect.Effect<void, NotFoundError> =>
  Effect.gen(function* () {
    const { db, events } = deps
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ sessionID })
    if (deps.interrupt) yield* deps.interrupt(sessionID)
    // AFTER the interrupt: the interrupted turn unwinds through its own scheduler release, and
    // evicting first would only leave the dead session's ledger entry to be re-created. Each
    // child evicts itself in the recursion below.
    if (deps.evict) yield* deps.evict(sessionID)
    yield* JhStore.purgeSession(db, sessionID)
    const children = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    for (const child of children) {
      // A concurrent removal already won the race for this child — fine, keep going.
      yield* removeSessionRecord(deps, child.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
    }
    yield* events.publish(
      SessionRecordEvent.Deleted,
      { sessionID, info: fromRow(row) },
      {
        location: Location.Ref.make({
          directory: AbsolutePath.make(row.directory),
          workspaceID: row.workspace_id ?? undefined,
        }),
      },
    )
    yield* events.remove(sessionID)
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const scheduler = yield* SessionScheduler.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const compactionRequests = yield* SessionCompactionRequest.Service
    // B1 — publish this instance's wake to the cycle-free producers of session work. `spawn` runs
    // inside a LOCATION graph and cannot reach `SessionExecution` (unbound + it depends on
    // `LocationServiceMap`, which builds that very graph — see run-coordinator.ts's wake-seam
    // header), so the executor is pushed to a dependency-free global relay instead of pulled. This
    // is the fifth caller of `execution.wake`, and the first that is not request-driven.
    // ⚠️ The relay is shared per composition root by Layer memoization, so exactly one graph may
    // attach; a second SessionV2 in one process would silently steal the spawner's executor — the
    // same "never a second SessionV2" rule httpapi/server.ts already enforces by ordering.
    yield* (yield* SessionRunCoordinator.Wake).attach(execution.wake)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = SessionMessageRead.decodeRow

    // The shared setter shape (setTitle/setMetadata/setArchived/setPermission): the cycle-free
    // `SessionPatch.patchSessionRecord` (read row -> fromRow -> merge -> full-info NATIVE
    // `session.updated` publish; also used by the runner's auto-title), with the missing-row
    // case mapped onto this service's NotFoundError.
    const patchRecord = (
      sessionID: SessionSchema.ID,
      merge: (info: SessionSchema.Info) => SessionSchema.Info | undefined,
    ): Effect.Effect<void, NotFoundError> =>
      Effect.gen(function* () {
        const found = yield* SessionPatch.patchSessionRecord({ db, events }, sessionID, merge)
        if (!found) return yield* new NotFoundError({ sessionID })
      })

    // F1c-2 — session removal on the core engine (body: `removeSessionRecord`). The layer
    // injects the execution interrupt (idle interruption is a no-op; V1 never interrupted and
    // left a runner fiber writing into a purged aggregate). V1's background-job sweep has no
    // core successor and never will: the `BackgroundJob` registry it swept was deleted
    // 2026-07-29 (nothing had called `start()` since F1b). Native BashJobs are in-memory and
    // die with the location (1H residue).
    const removeRecord = (sessionID: SessionSchema.ID): Effect.Effect<void, NotFoundError> =>
      removeSessionRecord(
        {
          db,
          events,
          interrupt: (id) => Effect.uninterruptible(execution.interrupt(id)),
          // The scheduler ledger is keyed by session id and nothing else ever dropped an entry:
          // `evict` existed but had no production caller, so the EEVDF ledger (and any in-flight
          // or waiting entry a hard kill left behind) grew for the life of the instance.
          evict: (id) => scheduler.evict(id),
        },
        sessionID,
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")((input) => createSessionRecord({ db, events, projects, store }, input)),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      // The filter surface lives in the deps-taking SessionRead seam (V1-nuke slice A) so
      // service-less callers (CLI) share exactly one implementation.
      list: Effect.fn("V2Session.list")((input = {}) => SessionRead.list(db, input)),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* SessionMessageRead.list(db, input)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const prompt = resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      // The `!command` shell op: run one command to completion and record it as a
      // SessionMessage.Shell (Started opens the message, Ended fills its output — the
      // projector + message-updater build the rendered message from those two events).
      // Unlike the V1 path there is no user/assistant bookkeeping and no streaming
      // (there is no Shell.Delta event); output is delivered whole in Ended. The
      // process runs against the session's Location (cwd + configured shell); the
      // spawner is provided directly so this does not depend on it being in the
      // Location output context.
      shell: Effect.fn("V2Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const messageID = SessionMessage.ID.create()
        const callID = Identifier.ascending("tool")
        yield* events.publish(SessionEvent.Shell.Started, {
          sessionID: input.sessionID,
          messageID,
          callID,
          command: input.command,
          timestamp: yield* DateTime.now,
        })
        const output = yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const loc = yield* Location.Service
          const appProcess = yield* AppProcess.Service
          const entries = yield* config.entries()
          const configuredShell = (
            Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))) as {
              shell?: string
            }
          ).shell
          const shellPath = Shell.preferred(configuredShell)
          const command = ChildProcess.make(shellPath, Shell.args(shellPath, input.command, loc.directory), {
            cwd: loc.directory,
            extendEnv: true,
            env: { TERM: "dumb" },
            stdin: "ignore",
            forceKillAfter: Duration.seconds(3),
          })
          const run = yield* appProcess.run(command, {
            combineOutput: true,
            maxOutputBytes: SHELL_MAX_OUTPUT_BYTES,
          })
          return run.output?.toString("utf8") ?? ""
        }).pipe(Effect.provide(locations.get(session.location)), Effect.provide(AppProcess.defaultLayer), Effect.orDie)
        yield* events.publish(SessionEvent.Shell.Ended, {
          sessionID: input.sessionID,
          callID,
          output,
          timestamp: yield* DateTime.now,
        })
        return messageID
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      // The `/command` op: expand a saved slash-command template and submit it as a prompt —
      // the model turn then rides the normal runner (V1 `SessionPrompt.command` likewise just
      // delegates to `prompt()`). CommandV2 + the shell machinery + SessionSpawner are location
      // services, resolved via the session's Location. Covers arg substitution + `` !`shell` ``
      // substitution + cmd.agent/cmd.model override + the subtask (command-as-subagent) branch +
      // submit — returning a discriminated `CommandResult` (prompt vs subtask). A name that
      // misses CommandV2 falls back to a SKILL (every skill is slash-invokable, V1 parity) and
      // then to the ExternalCommandSource seam (MCP prompts, resolved lazily) — the same union
      // the `/command` list serves; only then does a missing command die (the caller validates
      // existence). A spawn-quota trip dies for now (residue).
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        // Resolve the command and run any `` !`cmd` `` substitutions in the Location scope; the
        // shell run mirrors the `shell` op (configured shell + cwd; AppProcess provided directly).
        const resolved = yield* Effect.gen(function* () {
          const commands = yield* CommandV2.Service
          const cmd: CommandV2.Info = yield* commands.get(input.command).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.succeed(found)
                : Effect.gen(function* () {
                    const skills = yield* SkillV2.Service
                    const skill = (yield* skills.list()).find((item) => item.name === input.command)
                    if (skill)
                      return {
                        name: skill.name,
                        template: SkillCommand.template(skill),
                        ...(skill.description !== undefined ? { description: skill.description } : {}),
                      } as CommandV2.Info
                    const external = yield* ExternalCommandSource.Service
                    const entry = (yield* external.entries()).get(input.command)
                    if (entry)
                      return {
                        name: input.command,
                        template: yield* entry.template,
                        ...(entry.description !== undefined ? { description: entry.description } : {}),
                      } as CommandV2.Info
                    return yield* Effect.die(new Error(`Command not found: ${input.command}`))
                  }),
            ),
          )
          let text = expandCommandTemplate(cmd.template, input.arguments)
          const bashMatches = [...text.matchAll(COMMAND_BASH_REGEX)]
          if (bashMatches.length > 0) {
            const config = yield* Config.Service
            const loc = yield* Location.Service
            const appProcess = yield* AppProcess.Service
            const entries = yield* config.entries()
            const configuredShell = (
              Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))) as {
                shell?: string
              }
            ).shell
            const shellPath = Shell.preferred(configuredShell)
            const results = yield* Effect.forEach(bashMatches, (match) =>
              Effect.gen(function* () {
                const command = ChildProcess.make(shellPath, Shell.args(shellPath, match[1], loc.directory), {
                  cwd: loc.directory,
                  extendEnv: true,
                  env: { TERM: "dumb" },
                  stdin: "ignore",
                  forceKillAfter: Duration.seconds(3),
                })
                const run = yield* appProcess.run(command, {
                  combineOutput: true,
                  maxOutputBytes: SHELL_MAX_OUTPUT_BYTES,
                })
                return run.output?.toString("utf8").trim() ?? ""
              }),
            )
            let index = 0
            text = text.replace(COMMAND_BASH_REGEX, () => results[index++])
          }
          text = text.trim()
          // Command-as-subagent: when the resolved agent runs in "subagent" mode (or cmd.subtask
          // is set), SPAWN a child session to run the expanded command instead of prompting this
          // one — the command's agent/model go to the CHILD (not a session switch). SessionSpawner
          // + AgentV2 are location services, resolved in this same scope.
          const agents = yield* AgentV2.Service
          const agentName = cmd.agent ?? session.agent
          const agentInfo = agentName ? yield* agents.get(AgentV2.ID.make(agentName)) : undefined
          const isSubtask = (agentInfo?.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
          if (isSubtask) {
            const spawner = yield* SessionSpawner.Service
            // SpawnLimitError (quota) is caught by the block's orDie for now; surfacing it is residue.
            // The spawner wakes the child itself (B1) — `started` is residue here for the same
            // reason the quota error is: `command`'s result shape has no field to carry it yet.
            const spawned = yield* spawner.spawn({
              parentID: input.sessionID,
              text,
              ...(cmd.agent ? { agent: AgentV2.ID.make(cmd.agent) } : {}),
              ...(cmd.model ? { model: cmd.model } : {}),
            })
            return { kind: "subtask" as const, childID: spawned.id }
          }
          return { kind: "prompt" as const, text, agent: cmd.agent, model: cmd.model }
        }).pipe(Effect.provide(locations.get(session.location)), Effect.provide(AppProcess.defaultLayer), Effect.orDie)
        if (resolved.kind === "subtask") return { type: "subtask" as const, childID: resolved.childID }
        // Prompt path only: a command may declare its own agent/model — switch the session to them
        // BEFORE the turn (persisted, mirroring how promptAsync applies a per-turn model/agent) so
        // the command runs under its declared config. Residue: V1's per-turn (non-persisted) override.
        if (resolved.agent)
          yield* events.publish(SessionEvent.AgentSwitched, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            agent: resolved.agent,
          })
        if (resolved.model)
          yield* events.publish(SessionEvent.ModelSwitched, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            model: resolved.model,
          })
        // Submit as a fresh prompt (mirrors the `prompt` op's admit + wake; a command is a
        // genuine user turn, so it is queued, not steer-prefixed — cf. SLICE 8's steer caveat).
        const messageID = input.id ?? SessionMessage.ID.create()
        const prompt = resolvePrompt({ text: resolved.text })
        const delivery = "queue" as const
        const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
        const admitted = yield* SessionInput.admit(db, events, {
          id: messageID,
          sessionID: input.sessionID,
          prompt,
          delivery,
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof SessionInput.LifecycleConflict
              ? new PromptConflictError({ sessionID: input.sessionID, messageID })
              : Effect.die(defect),
          ),
        )
        if (!SessionInput.equivalent(admitted, expected))
          return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
        yield* execution.wake(admitted.sessionID)
        return { type: "prompt" as const, admitted }
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      // B10: live control handoff — take over (operator) or hand back (nova). Handing back
      // to nova WAKES the session so any input queued while the operator held control drains.
      switchResponder: Effect.fn("V2Session.switchResponder")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if ((session.responder ?? "nova") === input.responder) return
        yield* events.publish(SessionEvent.ResponderSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          responder: input.responder,
        })
        if (input.responder === "nova") yield* execution.wake(input.sessionID)
      }),
      // 1K: mid-session permission-mode switch (the MODE_RULES overlay applies on the next turn).
      switchMode: Effect.fn("V2Session.switchMode")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if ((session.permissionMode ?? "ask") === input.permissionMode) return
        yield* events.publish(SessionEvent.ModeSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          permissionMode: input.permissionMode,
        })
      }),
      // The per-session Strict-harness override (the composer switch) — applies on the next turn;
      // `null` clears the override back to inherit (parent chain, then global config.strict).
      switchStrict: Effect.fn("V2Session.switchStrict")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.StrictSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          strict: input.strict,
        })
      }),
      // A per-session harness-feature toggle (the composer's Tuning control) — applies on the next
      // turn; `null` clears the override back to inherit (parent chain, then global config).
      switchFeature: Effect.fn("V2Session.switchFeature")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.FeatureSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          feature: input.feature,
          enabled: input.enabled,
        })
      }),
      // The chat's kernel thread type (the composer's Mode control). Attendance derives from the
      // chain ROOT's type, so flipping a root chat to auto-prompting/goal-oriented is the "keep
      // working without me" switch (out-of-folder writes denied not asked, bash confined by the Agent Jail, affective
      // nudges engage). Consumers read the projected column fresh, so it applies immediately.
      switchType: Effect.fn("V2Session.switchType")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.TypeSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          sessionType: input.type,
        })
      }),
      // B4/T2: the per-session system-prompt override layer (info-sheet editor + the reconfigure
      // tool) — applies on the next turn; `null` clears the layer (back to inherit via the walk).
      switchPromptOverride: Effect.fn("V2Session.switchPromptOverride")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.PromptOverrideSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          override: input.override,
        })
      }),
      // F1c-1 — rename on the core engine. Unchanged titles dedup to no event.
      setTitle: Effect.fn("V2Session.setTitle")((input) =>
        patchRecord(input.sessionID, (info) =>
          info.title === input.title
            ? undefined
            : SessionSchema.Info.make({
                ...info,
                title: input.title,
                time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) },
              }),
        ),
      ),
      // F1c-4 — the remaining update-handler setters. V1 parity: metadata/permission replace
      // wholesale and bump time.updated; archiving does not bump time.updated (and clearing
      // `archived` is not a wire capability — the projector skips undefined columns).
      setMetadata: Effect.fn("V2Session.setMetadata")((input) =>
        patchRecord(input.sessionID, (info) =>
          SessionSchema.Info.make({
            ...info,
            metadata: input.metadata,
            time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) },
          }),
        ),
      ),
      setArchived: Effect.fn("V2Session.setArchived")((input) =>
        patchRecord(input.sessionID, (info) =>
          SessionSchema.Info.make({
            ...info,
            time: { ...info.time, archived: input.time === undefined ? undefined : DateTime.makeUnsafe(input.time) },
          }),
        ),
      ),
      setPermission: Effect.fn("V2Session.setPermission")((input) =>
        patchRecord(input.sessionID, (info) =>
          SessionSchema.Info.make({
            ...info,
            permission: [...input.permission],
            time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) },
          }),
        ),
      ),
      children: Effect.fn("V2Session.children")(function* (sessionID) {
        yield* result.get(sessionID)
        const rows = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, sessionID))
          .orderBy(asc(SessionTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      }),
      todos: Effect.fn("V2Session.todos")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionTodo.readTodos(db, sessionID)
      }),
      // F1c — fork on the core engine, and a REPAIR: the V1 fork copied only the LEGACY
      // message store, which native sessions never write, so post-F1b a fork silently lost
      // its transcript. Copies the native transcript strictly BEFORE `messageID` (V1 parity;
      // everything when omitted) into a fresh ROOT session as self-contained MessageRecorded
      // durable events — the forked aggregate replays without reaching into its source.
      // Deliberate V1 delta: the fork keeps the source's agent/model/permissionMode (V1
      // dropped them, demoting a fork to the default model mid-conversation).
      //
      // ⚠️ RULING 8 (2026-07-29): the config a fork carries is the source's CHAIN-RESOLVED
      // config, never its raw row — *"a fork returning less restricted than its source is a
      // defect, not a preference"*. The row alone was measurably not enough: it dropped
      // `systemPromptOverride`, `type`, `priority`, `responder`, `thinkingBudget`,
      // `surgicalEdits` and `askBeforeChanges` outright, plus EVERYTHING a child had inherited
      // from its parent rather than declared itself. The asymmetry that hid it: `spawn` gives
      // the child a `parentID` so the walk fills the gaps, and every inheritance test goes
      // through spawn — a fork is a ROOT, so it has no parent to inherit from and an
      // un-copied field is simply gone. Design + the materialise-vs-inherit answer:
      // `session/config-resolve.ts`, the FORK block.
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })
        let boundary: number | undefined
        if (input.messageID !== undefined) {
          const anchor = yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)),
            )
            .get()
            .pipe(Effect.orDie)
          if (!anchor)
            return yield* new SessionRevert.MessageNotFoundError({
              sessionID: input.sessionID,
              messageID: input.messageID,
            })
          boundary = anchor.seq
        }
        const source = fromRow(row)
        const location = Location.Ref.make({
          directory: AbsolutePath.make(row.directory),
          workspaceID: row.workspace_id ?? undefined,
        })
        const inherited = yield* forkSessionConfig(input.sessionID, (id) => store.get(SessionSchema.ID.make(id)))
        const forked = yield* createSessionRecord(
          { db, events, projects, store },
          {
            location,
            title: SessionTitle.forked(source.title),
            metadata: source.metadata ? structuredClone({ ...source.metadata }) : undefined,
            agent: inherited.agent ? AgentV2.ID.make(inherited.agent) : undefined,
            model: inherited.model
              ? ModelV2.Ref.make({
                  id: ModelV2.ID.make(inherited.model.id),
                  providerID: ProviderV2.ID.make(inherited.model.providerID),
                  variant: inherited.model.variant ? ModelV2.VariantID.make(inherited.model.variant) : undefined,
                })
              : undefined,
            systemPromptOverride: inherited.systemPromptOverride,
            type: inherited.type,
            priority: inherited.priority,
            permissionMode: inherited.permissionMode,
            strict: inherited.strict,
            introspection: inherited.introspection,
            quality: inherited.quality,
            affective: inherited.affective,
            // The saved ruleset is classified `absent-from-row` in `SESSION_CONFIG_FIELDS`: it has
            // a column but `sessionToConfig` does not map it, so the chain fold cannot see it
            // (architecture.md Phase 1 step 4 is blocked on the V1/V2 ruleset reconciliation, and
            // no V2 evaluator reads the column today). Copying the source's own column verbatim is
            // the only faithful carry available and can only PRESERVE restrictions, never widen
            // them. When step 4 lands and `permissionRules` joins `sessionToConfig`, this line goes
            // away and the fold carries it — the descriptor entry flips to `"resolved"` and the
            // fork test starts demanding it.
            permission: source.permission ? [...source.permission] : undefined,
            // Carried directly since 2026-07-29. These four used to finish through
            // `FeatureSwitched`/`ResponderSwitched` events because `sessionRow` silently dropped
            // `thinking_budget`/`surgical_edits`/`ask_before_changes` and `CreateInput` had no
            // `responder` — both fixed, so the workaround collapsed to this.
            responder: inherited.responder,
            thinkingBudget: inherited.thinkingBudget,
            surgicalEdits: inherited.surgicalEdits,
            askBeforeChanges: inherited.askBeforeChanges,
            // Ruling 8's exact case: safe mode is a RESTRICTION, so a fork of a safe-mode chain must
            // come back in safe mode. It arrives via the chain fold like the three above (it became
            // `"resolved"` when the column landed), not off the source's raw row.
            safeMode: inherited.safeMode,
            contextBudget: inherited.contextBudget,
          },
        )
        const sourceRows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            boundary === undefined
              ? eq(SessionMessageTable.session_id, input.sessionID)
              : and(eq(SessionMessageTable.session_id, input.sessionID), lt(SessionMessageTable.seq, boundary)),
          )
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        for (const messageRow of sourceRows) {
          const message = yield* decode(messageRow)
          const copied = {
            ...message,
            id: SessionMessage.ID.create(),
            // Only the Synthetic variant embeds its sessionID in the message body.
            ...("sessionID" in message ? { sessionID: forked.id } : {}),
          } as SessionMessage.Message
          yield* events.publish(
            SessionEvent.MessageRecorded,
            { sessionID: forked.id, timestamp: yield* DateTime.now, message: copied },
            { location },
          )
        }
        const fresh = yield* store.get(forked.id)
        return fresh ?? forked
      }),
      remove: Effect.fn("V2Session.remove")(removeRecord),
      // F1a SLICE 7 — manual compaction DELEGATES to the runner: mark the one-shot
      // SessionCompactionRequest and wake the session; the runner consumes the marker at the top
      // of its drain and runs the compact-only cycle in its own context (it holds the shared
      // LLMClient — the OFF-C chokepoint — plus model resolution and the history assembly; an
      // inline build here was reverted on exactly that wiring constraint). Progress surfaces as
      // durable Compaction.Started/Ended events with reason "manual".
      // First cut ignores `input.prompt` (extra summary guidance) — residue.
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        yield* compactionRequests.request(input.sessionID)
        yield* execution.wake(input.sessionID)
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        // K1 de-stub: join on completion, same semantics as the wait TOOL — poll the session's
        // `result` (set by exit() via the Completed event) until present. Times out after ~2
        // minutes with the retryable unavailable error, so a client keeps waiting by re-calling.
        const POLL_MS = 2000
        const MAX_POLLS = 60
        for (let i = 0; i < MAX_POLLS; i++) {
          const session = yield* result.get(sessionID)
          if (session.result !== undefined) return
          yield* Effect.sleep(Duration.millis(POLL_MS))
        }
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

// ⚠️ SessionScheduler is deliberately NOT provided here (like SessionExecution and
// LocationServiceMap): it stays a REQUIREMENT so the composition root hands this layer the SAME
// per-instance ledger the location-scoped runner admits against (httpapi/server.ts lists
// `SessionScheduler.node` in the instance-global group for exactly that reason). Providing a
// private one here would silently make `remove`'s eviction hit an empty ledger.
export const defaultLayer = layer.pipe(
  // The wake relay is provided (not left a requirement) because it is dependency-free and its
  // sharing rides Layer memoization on the ONE module-level layer object: the same instance the
  // location graph hoists (see run-coordinator.ts). Unlike SessionScheduler below, a private copy
  // is impossible here — there is only one `wakeLayer`.
  Layer.provide(SessionRunCoordinator.wakeLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(SessionCompactionRequest.defaultLayer),
  Layer.orDie,
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionRunCoordinator.wakeNode,
    SessionScheduler.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionCompactionRequest.node,
  ],
})
