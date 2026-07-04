export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Duration, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@novaclaw/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
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
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@novaclaw/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@novaclaw/schema/durable-event-manifest"
import { Config } from "./config"
import { CommandV2 } from "./command"
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

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
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
  location: Location.Ref
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
  readonly command: (input: CommandInput) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
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
    yield* db
      .insert(ProjectTable)
      .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const now = Date.now()
    const info = SessionV1.SessionInfo.make({
      id: sessionID,
      parentID: input.parentID,
      slug: Slug.create(),
      version: InstallationVersion,
      projectID: project.id,
      directory: input.location.directory,
      path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
      workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
      title: `New session - ${new Date(now).toISOString()}`,
      agent: input.agent,
      model: input.model
        ? {
            id: ModelV2.ID.make(input.model.id),
            providerID: input.model.providerID,
            variant: input.model.variant,
          }
        : undefined,
      systemPromptOverride: input.systemPromptOverride,
      type: input.type,
      priority: input.priority,
      permissionMode: input.permissionMode,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    })
    const projected = yield* events
      .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")((input) => createSessionRecord({ db, events, projects, store }, input)),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
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
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.provide(AppProcess.defaultLayer),
          Effect.orDie,
        )
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
      // delegates to `prompt()`). CommandV2 is a direct location-graph service, so it resolves
      // via the session's Location. First cut covers arg substitution + submit; `` !`shell` ``
      // substitution, the cmd.agent/cmd.model override, and the subtask branch are residue
      // (see todo.md F1a SLICE 5). A missing command dies — the caller validates existence.
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const cmd = yield* Effect.gen(function* () {
          const commands = yield* CommandV2.Service
          return yield* commands.get(input.command)
        }).pipe(Effect.provide(locations.get(session.location)))
        if (!cmd) return yield* Effect.die(new Error(`Command not found: ${input.command}`))
        const template = expandCommandTemplate(cmd.template, input.arguments)
        // Submit as a fresh prompt (mirrors the `prompt` op's admit + wake; a command is a
        // genuine user turn, so it is queued, not steer-prefixed — cf. SLICE 8's steer caveat).
        const messageID = input.id ?? SessionMessage.ID.create()
        const prompt = resolvePrompt({ text: template })
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
        return admitted
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
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
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

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
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
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
