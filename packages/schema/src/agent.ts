export * as Agent from "./agent"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { NonNegativeInt, PositiveInt, statics } from "./schema"

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
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  /** Roster profile — the durable half of a named agent's identity (AGENTS.md, the structural metaphor).
   *  These ride the PROFILE, never the transcript, which is what makes them survive compaction. */
  /** The display name. The `id` keys the memory scope and never changes; this is what people read
   *  and may rename. */
  name: Schema.String.pipe(optional),
  title: Schema.String.pipe(optional),
  personality: Schema.String.pipe(optional),
  /** Reporting line. Absent resolves to Nova; the runtime rejects self/cyclic lines. */
  superior: ID.pipe(optional),
  avatar: Schema.String.pipe(optional),
  /** `own` = private `agent:<id>` scope + `global`; `none` = a throwaway with no memory at all. */
  memory: Memory.pipe(optional),
  /** Keep compacted conversations in this agent's own memory (default on). */
  archiveChats: Schema.Boolean.pipe(optional),
  /** The capability floor this role needs (`agent/model-fit.ts`). Warns when the bound model is
   *  beneath it; never refuses. Absent = no floor declared, which is silence and not "micro". */
  needsTier: Model.Tier.pipe(optional),
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
  strict: Schema.Struct({
    enabled: Schema.Boolean.pipe(optional),
    attempts: Schema.Finite.pipe(optional),
    wallMinutes: Schema.Finite.pipe(optional),
  }).pipe(optional),
  shortChat: Schema.Boolean.pipe(optional),
  /** Finish re-grounding stance for this colleague; absent = the instance harness default. */
  reground: Schema.Boolean.pipe(optional),
  /** Per-turn reasoning-token ceiling. Absent = selected model default; 0 = reasoning disabled. */
  reasoningBudget: NonNegativeInt.pipe(optional),
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
