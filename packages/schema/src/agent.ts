export * as Agent from "./agent"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { Quality } from "./quality"
import { NonNegativeInt, PositiveInt, statics } from "./schema"
import { HorizonDays } from "./scratch-horizon"

export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
]).annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

/** Memory reach of one agent. Mirrors `ConfigV2.Agent.memory` — the config side is the authoring
 *  surface, this is the wire the roster UI reads. */
export const Memory = Schema.Literals(["own", "none"]).annotate({ identifier: "Agent.Memory" })
export type Memory = typeof Memory.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  model: Model.Ref.pipe(optional),
  /** Model used for reasoning-enabled turns. Absent = the ordinary model. */
  reasoningModel: Model.Ref.pipe(optional),
  workerModel: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  /** Roster profile — the durable half of a named agent's identity (AGENTS.md, the structural metaphor).
   *  These ride the PROFILE, never the transcript, which is what makes them survive compaction. */
  /** The display name. The `id` keys the memory scope and never changes; this is what people read
   *  and may rename. */
  name: Schema.String.pipe(optional),
  title: Schema.String.pipe(optional),

  /** Reporting line. Absent resolves to Nova; the runtime rejects self/cyclic lines. */
  superior: ID.pipe(optional),
  avatar: Schema.String.pipe(optional),
  /** `own` = private `agent:<id>` scope + `global`; `none` = a throwaway with no memory at all. */
  memory: Memory.pipe(optional),
  horizonDays: HorizonDays.pipe(optional),
  /** Keep compacted conversations in this agent's own memory (default on). */
  archiveChats: Schema.Boolean.pipe(optional),
  /** Caption each shell/spawn tool call with a generated title (default on). Costs a model call per
   *  call, so it is opt-out for agents whose work is shell-heavy. Read by the status sampler. */
  toolLabels: Schema.Boolean.pipe(optional),
  /** The model class this role expects (`smart` | `usual` | `fast` — never `special`, which the
   *  harness must not route to by itself). Warns when the bound model is beneath it; never refuses.
   *  Absent = no declared floor. */
  needsTaxonomy: Model.Requirement.pipe(optional),
  description: Schema.String.pipe(optional),
  /** The FOLDER this colleague works on. Absent = its own scratch (`AgentWorkspace.folderFor`). */
  directory: Schema.String.pipe(optional),
  /**
   * The colleague's OWN workspace — an absolute host path, derived and never authored.
   *
   * 🔴 Read-only and server-computed (`Scratch.forAgent`). It rides the agent record because it is a
   * property of the colleague, and because the app has no way to derive it: the scratch root lives
   * under the instance's data directory, which the client does not know and must not guess.
   *
   * ⚠️ Present whether or not `directory` is set — a colleague keeps this folder even when assigned
   * to a project (owner, 2026-08-22), and it is exactly the case where the user has no other route to
   * the files it writes there.
   */
  workspace: Schema.String.pipe(optional),
  /**
   * What this colleague is currently working on — one short line, for the Contacts row.
   *
   * 🔴 Owner, 2026-08-28: *"every few hours if agent did some work we update the current task name +
   * status, which we display in the contacts app, just like normal chat apps display contact
   * statuses"* — so both the user and other agents get quick feedback on any colleague without
   * opening its chat.
   *
   * ⚠️ Read-only and server-derived, riding the agent record for the same reason `workspace` does: it
   * is a property of the COLLEAGUE, and the app cannot compute it — it comes from a periodic pass
   * over transcripts the client never sees.
   *
   * ⚠️ ABSENT, not empty, when there is nothing to say. A colleague nobody has worked with has no
   * task, and a blank line where a sentence belongs is what "New session" was in the surface this
   * replaces. Contacts renders the row without a status rather than with an empty one.
   */
  status: Schema.Struct({
    task: Schema.String,
    /** Epoch millis of the newest activity the line was derived from — how current it is. */
    observed: Schema.Finite,
  }).pipe(optional),
  /** Standing WORK choices — folded as a layer by `AgentDefaults`, absent = inherit. */
  permissionMode: Schema.Literals(["plan", "ask", "bypass", "yolo"]).pipe(optional),
  /** Full per-officer Strict detail (every field optional); the session row still wins per chat. */
  strict: Schema.Struct({
    enabled: Schema.Boolean.pipe(optional),
    verification: Schema.Boolean.pipe(optional),
    recovery: Schema.Boolean.pipe(optional),
    editingAids: Schema.Boolean.pipe(optional),
    budgetSteering: Schema.Boolean.pipe(optional),
    attempts: Schema.Finite.pipe(optional),
    wallMinutes: Schema.Finite.pipe(optional),
    executionTokens: Schema.Finite.pipe(optional),
    reasoningTokens: Schema.Finite.pipe(optional),
  }).pipe(optional),
  shortChat: Schema.Boolean.pipe(optional),
  /** The three roster entity kinds: a full officer `agent`, a pure `chat`, or the owning `human`. */
  kind: Schema.Literals(["agent", "chat", "human"]).pipe(optional),
  /** Persistent operation defaults for the colleague's canonical root session. */
  operationMode: Schema.Literals(["interactive", "unattended"]).pipe(optional),
  goal: Schema.String.pipe(optional),
  /** Standing harness preferences, folded below project and chat overrides.
   *  `introspection` and `affective` carry the historical bare boolean or the full
   *  detail struct, exactly as the config side authors them. */
  contextBudget: Schema.Boolean.pipe(optional),
  surgicalEdits: Schema.Boolean.pipe(optional),
  introspection: Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      enabled: Schema.Boolean.pipe(optional),
      cadence: Schema.Finite.pipe(optional),
      model: Schema.String.pipe(optional),
      prompt: Schema.String.pipe(optional),
      interjection: Schema.String.pipe(optional),
      generateInterjection: Schema.Boolean.pipe(optional),
    }),
  ]).pipe(optional),
  quality: Schema.Boolean.pipe(optional),
  qualityConfig: Quality.Config.pipe(optional),
  context: Schema.Struct({
    enabled: Schema.Boolean.pipe(optional),
    profiles: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int)).pipe(optional),
    todo_reminder: Schema.Struct({
      enabled: Schema.Boolean.pipe(optional),
      cadence: Schema.Finite.pipe(optional),
      max_tokens: Schema.Finite.pipe(optional),
    }).pipe(optional),
  }).pipe(optional),
  compaction: Schema.Struct({
    auto: Schema.Boolean.pipe(optional),
    prune: Schema.Boolean.pipe(optional),
    summarize: Schema.Boolean.pipe(optional),
    summarizeInput: PositiveInt.pipe(optional),
    keep: Schema.Struct({ tokens: NonNegativeInt.pipe(optional) }).pipe(optional),
    buffer: NonNegativeInt.pipe(optional),
    threshold: Schema.Int.pipe(optional),
  }).pipe(optional),
  affective: Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      enabled: Schema.Boolean.pipe(optional),
      temperature: Schema.Finite.pipe(optional),
      extended: Schema.Boolean.pipe(optional),
    }),
  ]).pipe(optional),
  /**
   * This officer's tool horizon, applied AFTER the instance `tool_routing` table.
   * Narrowing only: `false` denies the tool for this officer's sessions; `true`
   * restores a routing-withdrawn tool, never a permission-withdrawn one.
   */
  tools: Schema.Record(Schema.String, Schema.Boolean).pipe(optional),
  /** Per-turn reasoning-token ceiling. Absent = selected model default; 0 = reasoning disabled. */
  reasoningBudget: NonNegativeInt.pipe(optional),
  /** Maximum wall time for one tool call in milliseconds. Descendant workers inherit it. */
  maxToolTimeoutMs: PositiveInt.pipe(optional),
  /** Named officer whose role is used as the template for spawned anonymous workers. */
  workerPrototype: ID.pipe(optional),
  /** Total unfinished workers allowed in this officer's worker tree. */
  maxWorkers: NonNegativeInt.pipe(optional),
  /** Number of worker generations allowed below this officer. */
  spawnDepth: NonNegativeInt.pipe(optional),
  /** Minutes between unchanged live-worker/shell reminders. */
  runtimeHeartbeatMinutes: PositiveInt.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  /**
   * Set aside WITHOUT being retired — the config's `disabled: true`.
   *
   * 🔴 Distinct from `hidden` (which is about the picker) and from retirement (which is
   * confirm-gated, archives the chats and moves the cabinet). A paused colleague stays ON the roster
   * and keeps its id, its chat, its cabinet and its usage; it simply may not act.
   */
  paused: Schema.Boolean.pipe(optional),
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
})
  .annotate({ identifier: "AgentV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) =>
        schema.make({ id, request: { headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] }),
    })),
  )

/** One minute of a colleague's output. The series that carries these is SPARSE — a minute with no
 *  output has no entry, so an absent minute means nothing happened rather than "measured zero". */
export interface UsageMinute extends Schema.Schema.Type<typeof UsageMinute> {}
export const UsageMinute = Schema.Struct({
  /** Epoch MINUTES (ms / 60000) — the bucket is the key, so the key is the bucket. */
  minute: Schema.Int,
  /** Tokens GENERATED in that minute: output + reasoning, what the model actually produced. */
  generated: Schema.Int,
}).annotate({ identifier: "Agent.UsageMinute" })

export interface TeamChatMessage extends Schema.Schema.Type<typeof TeamChatMessage> {}
export const TeamChatMessage = Schema.Struct({
  id: Schema.String,
  sender: ID,
  recipient: ID,
  turn: Schema.Literals(["ask", "answer", "announce"]),
  text: Schema.String,
  created: Schema.Finite,
}).annotate({ identifier: "Agent.TeamChatMessage" })

export interface TeamChatPage extends Schema.Schema.Type<typeof TeamChatPage> {}
export const TeamChatPage = Schema.Struct({
  data: Schema.Array(TeamChatMessage),
  cursor: Schema.Struct({
    older: Schema.optional(Schema.String),
    latest: Schema.optional(Schema.String),
  }),
}).annotate({ identifier: "Agent.TeamChatPage" })

/**
 * A colleague's own chat, resolved by the instance.
 *
 * ⚠️ This is the ANSWER, not a list to fold. The client could always derive it — `apps/roster-live.ts`
 * does, and the kernel derives the same thing in `RosterChat.chatFor` — but the client's input is
 * `GET /api/session`, whose documented default is "the newest 50 sessions". So a derivation over that
 * page is a derivation over a PAGE: a colleague whose current chat falls outside it is answered with
 * an older chat, or with nothing, and "nothing" is the same value that means "this colleague has
 * never had a chat".
 *
 * `RosterChat.chatFor` is deliberately not shared with the client across the wire boundary — the
 * kernel says so, and the rule is short enough to state and test twice. This endpoint is not that
 * sharing. It is the one question the client cannot answer correctly from what it already holds, so
 * the instance answers it, once, from SQL.
 */
export interface Chat extends Schema.Schema.Type<typeof Chat> {}
export const Chat = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /**
   * Where this chat actually runs — NOT the colleague's configured folder, which diverges the moment
   * the colleague is reassigned (`agent/workspace.ts`). A caller that must tell the chat something
   * true about its own root gets it here and nowhere else.
   */
  directory: Schema.String,
}).annotate({ identifier: "Agent.Chat" })

/**
 * Every root chat a colleague has, ARCHIVED INCLUDED.
 *
 * ⚠️ This is the wider set on purpose. `Agent.Chat` answers "which chat is this colleague's NOW" and
 * deliberately hides filed ones, because handing back the conversation the user just cleared is the one
 * thing that must never happen. "Clear chat" needs the opposite: the transcript on screen is often an
 * ARCHIVED one, which is the recorded incident where the clear reported nothing to do while the
 * transcript the user was reading stayed put.
 *
 * The client cannot build this from a session list. It was folding `GET /api/session`, whose default is
 * the newest 50 sessions, so a Clear over a colleague with more history than that silently removed only
 * part of it and reported success.
 */
export interface ChatSummary extends Schema.Schema.Type<typeof ChatSummary> {}
export const ChatSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  /** The archive instant, or null while the chat is live. Never absent: absent would mean unknown. */
  archived: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Agent.ChatSummary" })
