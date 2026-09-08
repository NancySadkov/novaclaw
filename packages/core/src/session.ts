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
import { forkSessionConfig, type SessionConfig } from "./session/config-resolve"
import { SessionConfigColumns } from "./session/config-columns"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@novaclaw/schema/prompt-input"
import { EventV2 } from "./event"
import { Memory } from "./kb-graph/memory"
import { WorldMemory } from "./kb-graph/world-memory"
import { SessionMemoryCleanup } from "./session/memory-cleanup"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { AgentStatus } from "./agent-status"
import { AgentStatusEvent } from "@novaclaw/schema/agent-status-event"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import path from "path"
import { fromRow } from "./session/info"
import { SessionHistory } from "./session/history"
import { JhStore } from "./jh/store"
import { SessionRunner } from "./session/runner/index"
import { SessionScheduler } from "./session/scheduler"
import { SessionStore } from "./session/store"
import { SessionCompactionRequest } from "./session/compaction-request"
import { SessionBootRecovery } from "./session/boot-recovery"
import { SessionExecution } from "./session/execution"
import { SessionJoin } from "./session/join"
import { SessionExecutionAttempt } from "./session/execution-attempt"
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
import { Revert } from "@novaclaw/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@novaclaw/schema/durable-event-manifest"
import { Config } from "./config"
import { ConfigHarnessDrives } from "./config/harness-drives"
import { SettingsConfigStore } from "./settings-config-store"
import { CommandV2 } from "./command"
import { ExternalCommandSource } from "./command/external-command-source"
import { SkillCommand } from "./command/skill-command"
import { SkillV2 } from "./skill"
import { SessionRead } from "./session/read"
import { moveArchivedToHistory } from "./session/rekey"
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

// T2 (notes/reports/entities-review-2026-07-06.md): "a project's sessions" is an entity-free query — every session whose
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
  // Device affinity (v0.2.0 B2): the `DeviceRegistry` id this session's turns are scheduled on.
  // undefined = inherit, then derive from the resolved model's endpoint.
  device?: string
  /** Explicit computer display for this session; undefined = inherit, then instance default. */
  controlBinding?: string
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
  memory?: boolean
  shortChat?: boolean
  location: Location.Ref
  // F1c fork: a fork seeds its record from the source (title + cloned metadata).
  title?: string
  metadata?: Record<string, unknown>
  /** When supplied, creation and the child's first queued input project in one event transaction. */
  openingPrompt?: SessionRecordEvent.OpeningPrompt
}

/**
 * ⚠️ A COMPILE-TIME guard, and it closes the WRITE-direction half of ruling 8 (the ECS audit,
 * `notes/reports/ecs-abstraction-audit-2026-08-08.md` §6 G1).
 *
 * `SESSION_CONFIG_FIELDS` made the READ direction undriftable — the fold, the fork, row⇄`Info` and
 * the resolved-config endpoint are all generated from it, and the endpoint is even keyed as an OPEN
 * MAP so the wire cannot become a second field list. The write direction never got that treatment:
 * this struct is a hand-written enumeration of the same set, and nothing checked that it covered it.
 * A field added to the descriptor and forgotten here would simply be unsettable at create — no error,
 * no test, because `undefined` means *inherit* and an inherited field looks exactly like a correct one.
 *
 * The failing branch carries the missing keys so the compiler NAMES them rather than only refusing —
 * the same shape `session/config-columns.ts` and `config-resolve.ts`'s `SessionLike` guard use.
 *
 * ⚠️ It checks KEY COVERAGE, not type compatibility: a field whose create type drifts from its
 * `SessionConfig` type is not caught here. `configFromInput` is what makes that mostly moot — the
 * spread has to typecheck against `Session.Info` — but say it out loud rather than let a reader
 * assume this guard is stronger than it is.
 */
type CreateInputCarriesEveryConfigField = keyof SessionConfig extends keyof CreateInput
  ? true
  : ["CreateInput is missing", Exclude<keyof SessionConfig, keyof CreateInput>]
const _createInputCarriesEveryConfigField: CreateInputCarriesEveryConfigField = true
void _createInputCarriesEveryConfigField

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

/**
 * Restoring a filed colleague is a typed transition, not a generic timestamp edit. The caller must
 * name the officer whose canonical chat is being restored; history rows and retired predecessors
 * therefore cannot be resurrected through the setter seam.
 */
export class RestoreUnavailableError extends Schema.TaggedErrorClass<RestoreUnavailableError>()(
  "Session.RestoreUnavailableError",
  {
    sessionID: SessionSchema.ID,
    reason: Schema.String,
  },
) {}

/**
 * A root session was created without naming its agent (NC-SEC-020).
 *
 * Typed rather than a defect: this is a caller mistake with a correct action attached — say whose
 * chat it is — so it belongs in the API's error channel and not in the crash log.
 */
export class OwnerRequiredError extends Schema.TaggedErrorClass<OwnerRequiredError>()("Session.OwnerRequiredError", {
  reason: Schema.String,
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
/**
 * 🔴 A FILED CHAT IS NOT A PLACE WORK HAPPENS.
 *
 * Archiving is deliberate and it means the conversation is history — the ECS lens says so outright:
 * *"an archived chat is history, not a component."* A component is where work is addressed; history
 * is not. So a prompt aimed at one is refused HERE, at the single seam every prompt passes through,
 * rather than in whichever client happened to remember.
 *
 * Measured on the owner's instance 2026-09-03: reassignment archived a colleague's chat and opened a
 * successor, correctly. The client stayed pinned to the predecessor, which then accepted **296 more
 * events over three minutes** — a file written and compiled into the colleague's scratch, and a write
 * to the real project refused, because that session's root really was scratch. Every layer behaved as
 * written and the user got work in the wrong place with no way to see why.
 *
 * ⚠️ The client fix that shipped first (the tab follows the colleague) closed ONE door. The CLI, the
 * HTTP API, a colleague's `ask`, a scheduled task and any integration reach this same seam, and none
 * of them knew either. AGENTS.md: *impossible > caught > named* — a guard in one caller is the middle
 * rung wearing the top one's clothes.
 *
 * ⚠️ It carries the SUCCESSOR, so the refusal states the remedy instead of only the problem. The
 * colleague's live chat is the answer to "then where should this have gone", and every caller that
 * can retry can retry there.
 */
export class SessionArchivedError extends Schema.TaggedErrorClass<SessionArchivedError>()(
  "Session.ArchivedError",
  {
    sessionID: SessionSchema.ID,
    /** The colleague's live chat, when it has one. Absent for a retired colleague — then there is
     *  genuinely nowhere for this to go, and saying so is the honest answer. */
    successorID: Schema.optional(SessionSchema.ID),
  },
) {}

export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

/**
 * Where the child's location graph comes from — a UNION, so the compiler settles it rather than a
 * runtime branch. With a parent it is the parent's (one lookup, so the two cannot disagree). Without
 * one — a rootless launch such as Calendar — the caller must name it, because there is nothing to
 * inherit and defaulting to the process cwd is how a scheduled run lands in the wrong tree.
 */
export type SpawnAt =
  | (SessionSpawner.SpawnInput & { readonly parentID: SessionSchema.ID; readonly location?: never })
  | (SessionSpawner.SpawnInput & { readonly parentID?: undefined; readonly location: Location.Ref })

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  /**
   * ⚠️ Fails with {@link OwnerRequiredError} when a ROOT is created without naming its agent
   * (NC-SEC-020). A child may omit it — there `undefined` means *inherit from the parent*.
   */
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, OwnerRequiredError>
  /**
   * Fork a child of an existing session through the CANONICAL seam (v0.2.0 prep).
   *
   * `SessionSpawner` is location-scoped and most callers are not, which is why they reached for
   * `create({parentID}) + prompt()` instead — and why they each grew their own partial version of
   * what the seam already does. This resolves the parent's location and delegates, so a global
   * caller gets the depth cap, the ACTIVE fan-out cap, the durable rate cap, ad-hoc recipe
   * inheritance, the executor handoff, and the honest `started` flag, from one place.
   *
   * ⚠️ The quota is why this matters rather than being tidiness. The spawner's caps are DB counts on
   * `parent_id`, so a child created off-seam still COUNTS against them: before this, messenger
   * dispatch could place sixteen live children and then the agent's own `spawn` would refuse with
   * `reason: "children"` — a quota spent by a path that checked none of it.
   *
   * ⚠️ Requires a parent. A ROOTLESS launch (Calendar) cannot use this and must not fake a parent to
   * get in; see `notes/reports/session-launch-sites-2026-08-11.md`.
   */
  readonly spawn: (
    input: SpawnAt,
  ) => Effect.Effect<SessionSpawner.SpawnResult, NotFoundError | OwnerRequiredError | SessionSpawner.SpawnLimitError>
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
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
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
      | "memory"
      | "shortChat"
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
  readonly restore: (input: {
    sessionID: SessionSchema.ID
    agent: AgentV2.ID
  }) => Effect.Effect<void, NotFoundError | RestoreUnavailableError>
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
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError | SessionArchivedError>
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
  /**
   * ⚠️ `OperationUnavailableError` because a command may declare its own `agent:`, and repointing a
   * session onto a colleague who already has a chat is refused — the same rule `switchAgent` applies,
   * reached through the shared guard rather than a second copy.
   */
  readonly command: (
    input: CommandInput,
  ) => Effect.Effect<CommandResult, NotFoundError | OperationUnavailableError | PromptConflictError>
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
/**
 * The live root chat a colleague already owns, if any — **the ONE chat-pick rule**.
 *
 * 🔴 Extracted because two callers now need it and they must not disagree. `createSessionRecord`
 * uses it to return the existing conversation instead of minting a second; `switchAgent` uses it to
 * refuse a move that would give one colleague two. Written twice, the two would drift, and the
 * symptom of the drift is exactly what this rule exists to prevent: a colleague with two
 * conversations, one of them unreachable because the roster can only show one.
 *
 * The three clauses are the same three `createSessionRecord` documents: a ROOT (a sub-agent inherits
 * its officer's id), NOT archived ("Clear chat" archives, which is how a fresh one is asked for), and
 * newest first so the pick is deterministic rather than whatever the planner returned.
 */
const liveRootFor = (db: Database.Interface["db"], agent: string) =>
  db
    .select()
    .from(SessionTable)
    .where(and(eq(SessionTable.agent, agent), isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)))
    .orderBy(desc(SessionTable.time_updated))
    .get()
    .pipe(Effect.orDie)

/**
 * ONE CHAT PER COLLEAGUE, applied to a session being MOVED onto an agent.
 *
 * 🔴 Shared by every door that repoints a session, because there is more than one and they failed
 * differently. `switchAgent` is the public endpoint; a saved command's `agent:` frontmatter published
 * `AgentSwitched` DIRECTLY from `V2Session.command`, bypassing the endpoint and its check entirely —
 * so a command could hand a colleague a second live root that the roster can never show, while the
 * endpoint one function away refused exactly that. Written twice, the two drift; the symptom of the
 * drift is the thing the rule exists to prevent.
 *
 * ⚠️ Three exemptions, each matching `createSessionRecord`'s:
 *   · switching onto the agent this chat ALREADY runs as is a no-op, not a conflict — otherwise
 *     re-issuing the same command fails the second time;
 *   · a POSTURE may hold many chats (`build` is the mode most chats run as);
 *   · only a ROOT can conflict — a sub-agent inherits its officer's id by design.
 */
const guardOneChat = (
  session: { readonly agent?: string | undefined; readonly parentID?: SessionSchema.ID | undefined },
  agent: string,
  sessionID: SessionSchema.ID,
  db: Database.Interface["db"],
) =>
  Effect.gen(function* () {
    if (session.agent === agent || AgentV2.POSTURE_IDS.has(agent)) return
    const live = yield* liveRootFor(db, agent)
    if (live && live.id !== String(sessionID) && session.parentID === undefined)
      return yield* new OperationUnavailableError({ operation: "switchAgent" })
  })

/**
 * What an untitled row is called.
 *
 * 🔴 A root that arrives with NEITHER an agent nor a title is the last shape that could still read as
 * a ghost: nothing on the row says who it belongs to or what it is for, and the chat list shows the
 * bare *"New session"* the owner objected to. A colleague's chat is named by its colleague and every
 * production caller passes one or the other — `messenger/gateway.ts` and `cli/cmd/run.ts` both title
 * theirs — so this names what is left: WHERE it is.
 *
 * ⚠️ Still a DEFAULT, deliberately. `SessionTitle.isDefault` is the only state auto-title may
 * replace, so this form is inside that pattern — the folder name holds the place until the first real
 * exchange earns a better one, rather than becoming permanent.
 *
 * ⚠️ NOT applied when a COLLEAGUE is named. That row is already attributable, and its title is the
 * colleague's business (the launcher and Contacts both pass one).
 *
 * ⚠️ A POSTURE is not a colleague, and the distinction became load-bearing when NC-SEC-020 made every
 * root name an agent. Testing `agent !== undefined` would have handed every `build` root the bare
 * *"New session"* — silently deleting the folder naming this function exists for, in exactly the case
 * it was written for. The premise above is the test: is this row attributable to SOMEONE? A posture
 * says how the chat runs, not whose it is.
 */
const defaultTitle = (input: CreateInput): string => {
  if (input.agent !== undefined && !AgentV2.POSTURE_IDS.has(input.agent)) return "New session"
  const folder = path.basename(input.location.directory).trim()
  return folder === "" ? "New session" : `New session in ${folder}`
}

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
    /**
     * 🔴 **A COLLEAGUE'S CHAT CARRIES THE COLLEAGUE'S ID** (owner, 2026-08-28: *"session should share
     * the id with agent. Single entity - no confusion. I.e. session is a component on an agent,
     * according to the ECS part of our vision"* — and, on why: *"we have deficient architecture,
     * which breeds bugs like rabbits. Fix the architecture, and the bugs will have no feeding
     * ground."*).
     *
     * The vision's ECS line — *"a session is an entity"* — was written when sessions were anonymous.
     * Named colleagues moved the entity up a level: the AGENT is the entity, and its chat is a
     * component hanging off it, like its memory, its folder and its model. A component does not get
     * an identity of its own; it is reached through the entity that owns it.
     *
     * ⚠️ This is what makes one-chat-per-colleague a fact of the DATA rather than a rule some code
     * has to remember to apply. `store.get` below now answers "does this colleague already have a
     * chat" without asking, and a whole class of defect stops being expressible: two sessions for one
     * colleague, a chat filed under a name that does not own it, a roster lookup that finds the wrong
     * one of two. Every one of those was a real bug in the last week.
     *
     * ⚠️ The `ses_` prefix stays because `SessionID` requires it — it is a TYPE tag, not an identity.
     * The mapping is total and reversible, so the id still names exactly one colleague.
     *
     * ⚠️ Safe as a path/URL segment because the agent id ALREADY has to be: `scratch.ensureForAgent`
     * makes a directory named by it. This adds no constraint that was not already load-bearing.
     *
     * ⚠️ TWO predicates below, deliberately, because they answer two questions. `colleagueRoot` asks
     * *is this a colleague's own chat* — that is what the one-chat guard turns on, and it holds
     * whether or not the caller supplied an id. The canonical id additionally needs
     * `input.id === undefined`, since a caller naming an id has already decided. Folding them into
     * one predicate silently took the guard away from every explicit-id caller, which is a second
     * live chat waiting to happen.
     */
    /**
     * 🔴 **NC-SEC-020 — a ROOT session names its agent. There is no anonymous chat.**
     *
     * `undefined` used to mean two different things here, and only one of them is legitimate. On a
     * CHILD it means *inherit from the parent*, which is the reading the report asks to reserve it
     * for. On a ROOT it meant nothing at all: the row stored no owner, so every turn resolved one
     * DYNAMICALLY from whatever the current default officer happened to be — a chat whose identity,
     * and therefore whose private memory cabinet, could change under it between turns.
     *
     * ⚠️ A posture is a perfectly good answer. `agent: "build"` records that this chat RUNS AS the
     * build posture — measured on the owner's own instances as 55–98 live `build` roots, i.e. the
     * ordinary case, not a workaround. What is refused is the ABSENCE, because an absence is what
     * gets re-derived per turn. The value may be anything; it may not be nothing.
     *
     * ⚠️ Refused rather than DEFAULTED, and the middle option was measured out of existence before
     * this was written. Defaulting to a colleague cannot work: the one-live-root rule is a DB index
     * on the `agent` column, so a second anonymous root owned by Nova violates it. Defaulting to a
     * posture reintroduces exactly the ghost `DEFAULT_COLLEAGUE_ID` was moved OFF `build` to
     * remove — a chat answering with no Contacts row, which *"did not appear to exist"*.
     */
    if (input.parentID === undefined && input.agent === undefined)
      return yield* new OwnerRequiredError({ reason: "A root session must name the agent it runs as." })
    const colleagueRoot =
      input.parentID === undefined && input.agent !== undefined && !AgentV2.POSTURE_IDS.has(input.agent)
    // A colleague root has one identity regardless of which caller supplied the request. An
    // explicit arbitrary id is ignored rather than creating a second spelling of the same agent.
    const canonical = colleagueRoot ? SessionSchema.ID.make(`ses_${input.agent}`) : undefined
    const claimed = canonical === undefined ? undefined : yield* store.get(canonical)
    // A LIVE chat at the canonical id IS this colleague's chat: the idempotent answer, reached
    // without a scan, because the id already said whose it is.
    if (claimed !== undefined && claimed.time.archived === undefined) return claimed
    // Preserve the old transcript, but free the canonical seat. The move is one transaction and
    // leaves the successor with the only live `ses_<agent>` row.
    if (canonical !== undefined && claimed?.time.archived !== undefined)
      yield* moveArchivedToHistory(db, claimed.id, SessionSchema.ID.create())
    const sessionID = colleagueRoot ? canonical! : (input.id ?? SessionSchema.ID.create())
    const recorded = yield* store.get(sessionID)
    if (recorded) return recorded
    // 🔴 ONE CHAT PER COLLEAGUE, enforced HERE because this is the one seam every creator reaches
    // (owner, 2026-08-23: *"every agent has a single chat … that also applies to Nova"*). The reason
    // is identity, not storage: a colleague with two conversations is two personalities wearing one
    // name, and the roster — which is the only door to a colleague's chat — can show exactly one of
    // them. Before this, `chatFor` silently picked the most recently touched and the loser became
    // UNREACHABLE while its tokens still rolled up into the colleague's totals: a chat that, to the
    // user, vanished.
    //
    // Returning the existing chat rather than failing is deliberate, and matches the idempotent
    // `if (recorded) return recorded` directly above: the product rule is "you already have that
    // conversation", which is an answer, not an error. It also means the UI needs no reuse probe.
    //
    // ⚠️ Three exclusions, each load-bearing:
    //   · `parentID === undefined` — a SUB-AGENT inherits its officer's id, so without this every
    //     spawned worker would collapse into its officer's chat and the fleet would be one session.
    //   · `agent !== undefined` — the messenger console, recipe cooks and the CLI all create
    //     agent-less roots (verified: none passes `agent`), and they are not colleague chats.
    //   · `time_archived IS NULL` — "Clear chat" ARCHIVES rather than deletes, which is precisely
    //     how the user asks for a fresh one. An archived chat must not block its own successor.
    // ⚠️ `isColleague`, NOT `agent !== undefined`. `agent` on a row means "the agent this session
    // RUNS AS" and defaults to `build` — so keyed on mere presence this guard would have collapsed
    // 54 live `build` chats into one on the owner's installed instance (scanned 2026-08-23). A
    // posture is not a person.
    //
    // 🔴 The check is the STATIC id set, deliberately, and not `AgentV2.Service`. `AgentV2.node` is a
    // LOCATION node while this layer is GLOBAL, so consulting the registry here crosses a layer
    // boundary the graph refuses to build (measured: `makeGlobalNode` rejected the deps list). The
    // set needs no service and covers the measured case exactly.
    //
    // ⚠️ Known narrowness, stated rather than hidden: `isColleague` also excludes `mode: "subagent"`
    // and `hidden` agents, and those two need the record. A hidden agent holding a ROOT chat would
    // therefore still be treated as a colleague here. Sub-agents are already excluded by the
    // `parentID` clause, so the residual gap is hidden-agent roots — narrow, and filed rather than
    // papered over.
    /**
     * ⚠️ Still here, and NOT redundant with the canonical id above: it is what covers rows that do
     * not carry one. Chats created before this change have generated ids, and — because the UI is a
     * thin client that reaches ANY instance by URL — so do chats on an instance running an older
     * build. Without this scan a colleague with a legacy chat would silently get a second one.
     *
     * It is a lookup, not a second rule: both answer the same question, and the id answers it for
     * everything written from here on.
     */
    if (colleagueRoot && input.agent !== undefined) {
      const live = yield* liveRootFor(db, input.agent)
      if (live) {
        const existing = yield* store.get(SessionSchema.ID.make(live.id))
        if (existing) return existing
      }
    }
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
      title: input.title ?? defaultTitle(input),
      metadata: input.metadata,
      // Every per-session CONFIG field, generated from `SESSION_CONFIG_FIELDS` rather than listed
      // here — the descriptor is the count, so nothing here can go stale against it.
      // Until 2026-08-08 this literal named each one — the THIRD hand-written copy of
      // that list, and the same defect class that made `sessionRow` drop `thinking_budget`,
      // `surgical_edits` and `ask_before_changes` for four months (two of them RESTRICTIONS, so a
      // create meaning to restrict produced an unrestricted session and nothing said so).
      // `config-columns.ts` now generates all three directions from one descriptor.
      ...SessionConfigColumns.configFromInput(input),
      // ⚠️ There is no saved `permission` ruleset any more. It was WRITTEN by create and
      // `setPermission` and READ by nobody — `permission.ts` resolves the AGENT's ruleset
      // (`configured(sessionID, agentID)`) and never consulted the session row. v0.2.0 ruling 16
      // removed per-session `permissionRules` for having zero consumers; this was its successor
      // field, quietly carrying the same defect. Removed rather than wired up: one authority for
      // permissions is the decision (notes/named-agents.md), and a second one on the session row is
      // the widening path the org chart calls a coup.
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
    })
    const projected = yield* events
      .publish(
        SessionRecordEvent.Created,
        {
          sessionID,
          info,
          ...(input.openingPrompt === undefined ? {} : { openingPrompt: input.openingPrompt }),
        },
        { location: input.location },
      )
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
 * coordinator, as does workspace removal), then the injected `evict`, depth-first over children,
 * publish the full-info legacy `session.deleted` (its projector row-delete cascades
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
    /**
     * 🔴 The chat's MEMORIES are a second store, and this function never reached it (NC-SEC-019). The
     * confirmation promises the whole conversation and its history are removed permanently while every
     * `scope: "session"` memory survived on disk.
     *
     * A tombstone rather than a call: the graph opens lazily and can be down, and there is no
     * transaction spanning both stores. Writing it FIRST means a crash can leave a tombstone for a
     * session that still exists, which `SessionMemoryCleanup.sweep` retracts by re-checking — clearing
     * a live chat's memories is much worse than delaying a dead one's, so the ordering is chosen to
     * fail in the recoverable direction.
     */
    yield* SessionMemoryCleanup.request(db, sessionID)
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
    const location = Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ?? undefined,
    })
    // A colleague's current task is a component of its one live ROOT chat. Child workers share the
    // officer id, so clearing one of them must not erase the officer's job; clearing the root must.
    if (
      row.parent_id === null &&
      row.time_archived === null &&
      row.agent &&
      !AgentV2.POSTURE_IDS.has(AgentV2.ID.make(row.agent))
    ) {
      yield* AgentStatus.removeFrom(db, row.agent)
      yield* events.publish(AgentStatusEvent.Removed, { agent: row.agent }, { location })
    }
    yield* events.publish(
      SessionRecordEvent.Deleted,
      { sessionID, info: fromRow(row) },
      { location },
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
    const attempts = yield* SessionExecutionAttempt.Service
    const scheduler = yield* SessionScheduler.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const compactionRequests = yield* SessionCompactionRequest.Service
    // The same seam `session/runner/maintenance.ts` uses to reach memory from the session side.
    const memory = Memory.client(yield* Memory.node.service)
    const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
    // B1 — publish this instance's wake to the cycle-free producers of session work. `spawn` runs
    // inside a LOCATION graph and cannot reach `SessionExecution` (unbound + it depends on
    // `LocationServiceMap`, which builds that very graph — see run-coordinator.ts's wake-seam
    // header), so the executor is pushed to a dependency-free global relay instead of pulled. This
    // is the fifth caller of `execution.wake`, and the first that is not request-driven.
    // ⚠️ The relay is shared per composition root by Layer memoization, so exactly one graph may
    // attach; a second SessionV2 in one process would silently steal the spawner's executor — the
    // same "never a second SessionV2" rule httpapi/server.ts already enforces by ordering.
    yield* (yield* SessionRunCoordinator.Wake).attach(execution.wake)
    // …and having adopted an executor, re-drive what the PREVIOUS process left durable and
    // unfinished: abandoned execution leases, and queued prompts nothing in memory will promote.
    // Here rather than in an executor because there are two of them (worker in production, local
    // in core) and only one had ever swept — see `session/boot-recovery.ts`.
    /**
     * 🔴 **The INSTANCE settings store, not `Config` — and the typechecker is what said so.**
     *
     * The first version read `Config.Service`, which failed to compile: `Config.node` is a
     * LOCATION node and this is a GLOBAL one. That is not a lint, it is the architecture answering a
     * question I had not asked — *which location's config governs a sweep over every session?* There
     * is no answer, because the sweep is not in a location.
     *
     * `harness_drives` is an INSTANCE setting: it lives in the settings store, which is global, and
     * a project's `novaclaw.json` has no business turning crash-resume off for the whole box (and
     * could not, under principle 13's narrow-only rule). So the global store is both the thing that
     * compiles and the thing that is correct.
     */
    const recoverySettings = yield* SettingsConfigStore.Service
    yield* SessionBootRecovery.start({
      db,
      store,
      attempts,
      execution,
      /**
       * `harness_drives.resumeInterrupted`, read THROUGH to the store each time a sweep recovers
       * something (ruling 3). ⚠️ Fails OPEN — an unreadable config resumes, because the whole point
       * of this switch is that work is not silently lost, and a config read that failed is exactly
       * the moment to prefer the safe direction.
       */
      resumeInterrupted: () =>
        // ⚠️ `recoverySettings` is resolved at LAYER scope (above), not inside this thunk. Resolving
        // the tag here leaks `SettingsConfigStore.Service` into the Effect's requirement channel, and
        // `start` types the callback as `Effect<boolean>` with no requirements — so it must be in hand.
        // It is also the pattern `session/join.ts` records a revert for: resolving a service inside a
        // per-request closure is what broke the drain there.
        recoverySettings.all().pipe(
          Effect.map((all) => {
            // The resolver schema-checks this unknown store value. A hand-edited or half-migrated row
            // falls through to ON — the safe direction, since the point is that work is not silently lost.
            return ConfigHarnessDrives.resolve(all["harness_drives"]).resumeInterrupted
          }),
          Effect.orElseSucceed(() => true),
        ),
    })
    /**
     * 🔴 **…and DISCHARGE the memory tombstones the previous process could not.**
     *
     * `removeSessionRecord` writes a durable `session_memory_cleanup` row and then sweeps it
     * best-effort, under a comment promising the row "guarantees the cleanup happens; this is only
     * what makes it happen NOW rather than at the next boot". **There was no next-boot sweep.** So a
     * deletion that ran while the memory engine was down (or with `memory` off) left every
     * `scope: "session"` memory on disk under `session:<deleted-id>` — still enumerable in the
     * Memory app — until the user happened to delete another chat. The promise the confirmation
     * makes ("removed permanently") was discharged by an unrelated user action or not at all.
     *
     * ⚠️ A feature built, tested and never called is indistinguishable from the bug it replaced;
     * this is the caller. Forked and ignored for the same reason the two arms above are: boot is
     * where the self-healing law is void, so a sweep that cannot run must degrade rather than take
     * the instance down. `sweep` is idempotent, re-checks liveness (a tombstone for a session that
     * still exists is RETRACTED, never applied), and leaves a row it could not clear for next time —
     * so running it here can only move the outstanding set toward zero.
     */
    yield* Effect.forkScoped(SessionMemoryCleanup.sweep(db, memory, worldMemory).pipe(Effect.ignore))
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = SessionMessageRead.decodeRow

    // The shared setter shape (setTitle/setMetadata/setArchived): the cycle-free
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
      ).pipe(
        /**
         * …then discharge the memory tombstones the removal just wrote.
         *
         * ⚠️ AFTER the removal, and best-effort. The durable row is what guarantees the cleanup
         * happens; this is only what makes it happen NOW rather than at the next boot. A sweep that
         * failed here must not fail the deletion, which the user has already been told succeeded —
         * the tombstone survives and the next sweep takes it.
         *
         * ⚠️ `Memory.client(...)` is a PROXY over a lazily-opened engine, so this neither opens the
         * store nor makes memory a hard dependency of deleting a chat. With memory disabled the sweep
         * defers every row forever, which is correct: there is no store holding anything to clear.
         */
        Effect.tap(() => SessionMemoryCleanup.sweep(db, memory, worldMemory).pipe(Effect.ignore)),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")((input) => createSessionRecord({ db, events, projects, store }, input)),
      // The child inherits the PARENT's location, which is also the location whose graph owns the
      // spawner — one lookup, so the two can never disagree.
      spawn: Effect.fn("V2Session.spawn")(function* (input) {
        const at = input.parentID === undefined ? input.location : (yield* result.get(input.parentID)).location
        return yield* SessionSpawner.Service.pipe(
          Effect.flatMap((spawner) => spawner.spawn(input)),
          Effect.provide(locations.get(at)),
        )
      }),
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
            const target = yield* result.get(input.sessionID)
            // The invariant, at the one seam every prompt reaches. See `SessionArchivedError`.
            if (target.time.archived !== undefined) {
              const successor = target.agent === undefined ? undefined : yield* liveRootFor(db, target.agent)
              return yield* new SessionArchivedError({
                sessionID: input.sessionID,
                ...(successor?.id === undefined ? {} : { successorID: SessionSchema.ID.make(successor.id) }),
              })
            }
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
        // 🔴 THROUGH THE SHARED GUARD, not a bare publish. This used to write `AgentSwitched`
        // directly, so a saved command's `agent:` frontmatter could point a second session at a
        // colleague who already had a chat — the exact conflict `switchAgent` refuses one function
        // away. One rule, every door.
        if (resolved.agent) {
          yield* guardOneChat(session, resolved.agent, input.sessionID, db)
          yield* events.publish(SessionEvent.AgentSwitched, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            agent: resolved.agent,
          })
        }
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
      /**
       * 🔴 **The other door into "one chat per colleague" — and it had no lock on it.**
       *
       * `createSessionRecord` enforces the invariant for anyone CREATING a chat, but a switch moves
       * an existing chat onto an agent, and this endpoint published the event unconditionally. Point
       * a second root at a colleague who already has one and they own two: the roster can show only
       * one of them, so the other becomes unreachable while its tokens still roll up into that
       * colleague's totals — the exact failure the create-side guard was written to stop, reached
       * through a different door. It is public, and a command's `agent:` frontmatter reaches it too.
       *
       * ⚠️ Refuses rather than silently doing nothing: a switch that reports success and leaves the
       * chat where it was is the "message can be the lie" defect. `OperationUnavailableError` already
       * declares `switchAgent` in its operation literal, so this needed no new error type.
       *
       * ⚠️ A switch onto the agent this chat ALREADY runs as is a no-op, not a conflict — otherwise
       * re-issuing the same command fails the second time.
       */
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* guardOneChat(session, input.agent, input.sessionID, db)
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
      // B4/T2: the per-session system-prompt override layer (info-sheet editor + the session
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
      restore: Effect.fn("V2Session.restore")(function* (input) {
        const info = yield* result.get(input.sessionID)
        if (info.time.archived === undefined) return
        const agent = info.agent
        const canonical = agent === undefined ? undefined : SessionSchema.ID.make(`ses_${agent}`)
        if (
          info.parentID !== undefined ||
          agent === undefined ||
          AgentV2.POSTURE_IDS.has(agent) ||
          String(input.agent) !== String(agent) ||
          canonical === undefined ||
          info.id !== canonical
        )
          return yield* new RestoreUnavailableError({
            sessionID: input.sessionID,
            reason: "Only an archived officer's canonical root chat can be restored.",
          })

        const live = yield* liveRootFor(db, String(agent))
        if (live !== undefined && live.id !== info.id)
          return yield* new RestoreUnavailableError({
            sessionID: input.sessionID,
            reason: `Officer ${agent} already has a live chat (${live.id}).`,
          })

        yield* events.publish(
          SessionRecordEvent.Updated,
          {
            sessionID: input.sessionID,
            info: SessionSchema.Info.make({
              ...info,
              time: { ...info.time, archived: undefined },
            }),
            clearArchived: true,
          },
          {
            location: Location.Ref.make({
              directory: info.location.directory,
              workspaceID: info.location.workspaceID,
            }),
          },
        )
      }),
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
            /**
             * 🔴 **A FORK IS A BRANCH OF ITS SOURCE — a child, carrying that chat's owner.**
             *
             * Owner, 2026-08-28: *"no ghosthouse architecture"*, and *"our vision breaks all ties …
             * pick the best and most robust architecture, which fits our ECS nicely."*
             *
             * ⚠️ This SUPERSEDES the 2026-08-23 ruling that a fork drops the identity and makes a
             * fresh ROOT. That call was right about what it forbade — a second ROOT bearing a
             * colleague's id is a second chat for that colleague — and wrong about the only way out.
             * Dropping the owner bought the exemption with a row belonging to nobody, which is the
             * ghost the later ruling names.
             *
             * The ECS lens settles it. The chat is a COMPONENT of the agent, and a fork of Xenia's
             * chat contains Xenia's words: it hangs off her, or it hangs off nothing. And the reason
             * one-chat-per-colleague exists is that *"the roster is the only door to a colleague's
             * chat"* — a branch is not reached from the roster, it is reached through the chat it
             * came from. That is what a child IS. The invariant is untouched: it governs ROOTS.
             *
             * ⚠️ Deleting the source takes its branches with it (`removeSessionRecord` cascades), and
             * that is the rule working rather than a wart: a branch whose source is gone is reachable
             * from nowhere, which is the very thing being abolished.
             *
             * ⚠️ The TYPE is inherited, not forced, and that is what makes the tab work. The titlebar
             * collapses SUB-AGENT sessions into their parent's tab — worker threads must not each open
             * one — so a branch of an interactive chat is interactive and gets its own tab, while a
             * branch of a worker stays a worker. Forcing `interactive` here would also have broken the
             * contract the fork suite pins: a fork carries the source's resolved config — with ONE
             * reasoned exclusion, `agent`, for the reason spelled out at the `agent:` key below.
             */
            parentID: SessionSchema.ID.make(input.sessionID),
            title: SessionTitle.forked(source.title),
            metadata: source.metadata ? structuredClone({ ...source.metadata }) : undefined,
            // 🔴 A FORK DOES NOT CARRY A COLLEAGUE'S IDENTITY (owner, 2026-08-23:
            // *"no dead code allowing spawning extra sessions for agent"*). A fork makes a fresh
            // ROOT, and a rooted session bearing a colleague's id is a second chat for that
            // colleague, which is the one thing the invariant forbids. Carrying it made the
            // `SessionV2.fork` suite red the moment the guard could see it, and the fix is not to
            // exempt fork — an exemption IS the appendix — but to stop it duplicating an identity.
            //
            // Under the ECS merge (agent ⟷ session are one entity) forking an agent-session IS
            // cloning, and clone already exists and already mints a first-class id. So a fork is
            // what remains once identity is removed: a branch of the TRANSCRIPT, which is exactly
            // what the user asked for when they forked a message.
            //
            // ⚠️ A POSTURE still carries, and the distinction is the whole point: `build`/`plan` are
            // permission modes wearing an agent's shape, not people, so a fork keeping `plan` keeps
            // a MODE and duplicates no identity. `session-fork-config.test.ts` forks a `plan` root
            // and requires every carried field to survive — that ledger stays green, and `agent`
            // gains a REASONED exclusion for colleagues rather than being dropped wholesale.
            agent:
              inherited.agent && AgentV2.POSTURE_IDS.has(inherited.agent)
                ? AgentV2.ID.make(inherited.agent)
                : undefined,
            model: inherited.model
              ? ModelV2.Ref.make({
                  id: ModelV2.ID.make(inherited.model.id),
                  providerID: ProviderV2.ID.make(inherited.model.providerID),
                  variant: inherited.model.variant ? ModelV2.VariantID.make(inherited.model.variant) : undefined,
                })
              : undefined,
            // Device affinity rides the chain fold like the switches below: a fork of a session
            // pinned to a device stays on that device, because a fork that silently moved to
            // another backend would be scheduled against capacity its source never claimed.
            device: inherited.device,
            controlBinding: inherited.controlBinding,
            systemPromptOverride: inherited.systemPromptOverride,
            type: inherited.type,
            priority: inherited.priority,
            permissionMode: inherited.permissionMode,
            strict: inherited.strict,
            introspection: inherited.introspection,
            quality: inherited.quality,
            affective: inherited.affective,
            // ⚠️ The `permission` COLUMN survives this removal on purpose. Dropping a column needs a
            // migration, and an unused column is inert where a bad migration is not; the field, the
            // service method and every write are gone, so nothing can put anything in it again.
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
            memory: inherited.memory,
            shortChat: inherited.shortChat,
          },
          // ⚠️ `OwnerRequiredError` is unreachable here and stays out of `fork`'s contract: the call
          // above always passes `parentID`, and that error is raised only for a ROOT. A defect is the
          // honest encoding of "this cannot happen" — if the parentID above ever went away, this
          // would fail loudly at the seam rather than widening an error type nobody can act on.
        ).pipe(Effect.orDie)
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
        /**
         * 🔴 **A FORK CARRIES ITS SOURCE'S CONTEXT STATE, NOT JUST ITS TRANSCRIPT.**
         *
         * The loop above copies `SessionMessageTable`, and the compaction overlay does not live in
         * that table: `Compaction.Ended` projects into `session_compaction`, and
         * `SessionHistory.projectedEntries` synthesises the overlay from there. So a fork of a chat
         * that had already compacted got no `session_compaction` row, `latestCompaction` returned
         * `undefined`, and `messageRows` ran with no `seq > prefix_seq` bound — the fork's very
         * first turn assembled the FULL raw history its source had summarised away. On a small
         * model that is the context overflow this harness exists to prevent, and the fork must burn
         * a fresh summarisation call before it can answer anything.
         *
         * Ruling 8 says a fork carries the source's resolved CONFIG. This is the same argument one
         * layer down: a fork that comes back needing more context than its source is a defect, not
         * a preference.
         *
         * ⚠️ **Through `latestCompaction`, so a STALE overlay is not propagated.** It re-derives the
         * source's prefix hash and yields nothing when the stored overlay no longer matches the
         * transcript it claims to cover — carrying one of those forward would mint a second copy of
         * a row the source itself refuses to apply.
         *
         * ⚠️ **The seqs are RE-MAPPED, never copied.** `prefix_seq` is an aggregate sequence and the
         * fork is a different aggregate, so the boundary is carried by POSITION: the source rows are
         * copied in `seq` order, so the n-th copied row is the n-th source row and the fork's
         * boundary is the seq of the row at the same index. The hash is recomputed over the FORK's
         * rows for the same reason — new ids and new seqs hash differently, and a copied hash would
         * be rejected as stale on the first load.
         */
        const sourceCompaction = yield* SessionHistory.latestCompaction(db, SessionSchema.ID.make(input.sessionID))
        // An overlay whose prefix reaches past the fork point summarises messages this fork does not
        // have. There is no honest boundary for it here, so it is dropped rather than truncated.
        if (sourceCompaction && (boundary === undefined || sourceCompaction.prefix_seq < boundary)) {
          const prefixCount = sourceRows.filter((messageRow) => messageRow.seq <= sourceCompaction.prefix_seq).length
          const forkedRows = yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, forked.id))
            .orderBy(asc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          // The positional map is only sound if every source row landed. It always does today; if it
          // ever does not, a fork with no overlay is a slow fork, and a fork with a MISPLACED overlay
          // is a fork that silently drops or duplicates messages.
          const forkedPrefixSeq =
            prefixCount > 0 && forkedRows.length === sourceRows.length ? forkedRows[prefixCount - 1]?.seq : undefined
          if (forkedPrefixSeq !== undefined)
            // `Compaction.Ended` and not a direct INSERT: the projector is the one writer of
            // `session_compaction`, and a second one is how the two copies drift. `Started` is
            // deliberately not published — nothing projects it, and a fork did not run a summariser.
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: forked.id,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              reason: sourceCompaction.reason,
              text: sourceCompaction.summary,
              recent: sourceCompaction.recent,
              prefixSeq: forkedPrefixSeq,
              prefixHash: yield* SessionHistory.prefixHash(db, forked.id, forkedPrefixSeq),
            })
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
        // 🔴 **This is the SAME join the `wait` tool uses now — it was a second one** ().
        //
        // It used to be a hand-rolled `for (let i = 0; i < 60)` loop re-reading the session row every
        // 2000 ms, under a comment claiming *"same semantics as the wait TOOL"*. It had neither the
        // transport nor the bound: `SessionJoin` is a durable event stream (no polling — `join.ts`'s
        // header names *"polling SQLite every two seconds"* as the shape it replaced), and its bound
        // is `JOIN_TIMEOUT_MS`, raised from 2 minutes on 2026-08-20 after a child asked only to reply
        // "BANANA" settled 121.7 s after `wait` started. So this door returned "operation
        // unavailable" for healthy children on a single-device box — the exact false negative the
        // tool path was fixed for — because a fix landed on one of two copies.
        //
        // ⚠️ The store read stays, and stays FIRST. It is what turns an unknown id into
        // `NotFoundError` (the endpoint's 404), and it is the fast path for a session that has
        // already exited — `result` is set by `exit()` via the same Completed event this joins on, so
        // the two agree, and re-reading it costs one row rather than a subscription.
        const existing = yield* result.get(sessionID)
        if (existing.result !== undefined) return
        // ⚠️ `fromParts`, and built from what this layer ALREADY holds — never `yield* SessionJoin.Service`.
        // `join.ts` records why: resolving that tag inside a per-request scope forced its layer to
        // build there and abandoned every tool-call turn. The parts are the same three the join's own
        // layer passes, and `sequence` is what makes this join the CURRENT epoch rather than the first
        // completion in the child's lifetime — replaying from zero returned the first answer forever.
        const joined = yield* SessionJoin.fromParts({
          events,
          session: (childID) => store.get(childID),
          sequence: (childID) => EventV2.latestSequence(db, childID),
        }).awaitCompletion({
          childID: sessionID,
          timeoutMs: SessionJoin.JOIN_TIMEOUT_MS,
        })
        // ⚠️ A timeout still answers `OperationUnavailableError`, not a success: the endpoint's
        // contract is "re-call to keep waiting", and reporting completion for a child still running
        // would be a false statement about the run (ruling 2).
        if (!joined.completed) return yield* new OperationUnavailableError({ operation: "wait" })
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
  // Boot recovery reclassifies abandoned leases, so it needs the SAME attempt service the executor
  // writes through. Provided as the shared module-level layer object (like SessionStore above), so
  // Layer memoization gives this and `SessionExecutionWorker.defaultLayer` one instance, not two.
  Layer.provide(SessionExecutionAttempt.defaultLayer),
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
    SessionExecutionAttempt.node,
    SessionRunCoordinator.wakeNode,
    SessionScheduler.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionCompactionRequest.node,
    Memory.node,
    WorldMemory.node,
    // For the boot-recovery resume switch — an INSTANCE setting, so the global store rather than the
    // location-scoped `Config`. See the note at `recoverySettings`.
    SettingsConfigStore.node,
  ],
})
