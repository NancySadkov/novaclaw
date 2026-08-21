export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { ConfigProvider } from "./provider"
import { PositiveInt } from "../schema"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

/** How much of the memory graph an agent may read and write (AGENTS.md, the structural metaphor).
 *
 *  `own` — the officer's own filing cabinet: its private `agent:<id>` scope plus the household's
 *  `global` facts. This is the default and the reason the roster exists: a D&D companion's recall must
 *  never reach the trading desk.
 *  `none` — a THROWAWAY agent (the owner's "Crashtest Joe"): reads nothing, writes nothing. What a
 *  probe, a benchmark and a fan-out child all want, and the honest way to isolate a measurement.
 *
 *  ⚠️ Nova is not exempt and is not a super-user: its memory is `own` like everyone else's, personal to
 *  it (owner, 2026-08-19). Governing the roster is a lifecycle power, never a reading power. */
export const Memory = Schema.Literals(["own", "none"])
export type Memory = typeof Memory.Type

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  /** What this colleague is CALLED. Defaults to a Greek name drawn from `agent/officer-name.ts` when
   *  Nova hires someone, and the user may rename it freely afterwards.
   *
   *  🔴 Separate from the id ON PURPOSE, and this is the whole reason the field exists: the id keys
   *  the agent's memory scope (`agent:<id>`), so it must never change, while a name is something a
   *  person should be free to change their mind about. Renaming an id would orphan a colleague from
   *  everything it remembers. */
  name: Schema.String.pipe(Schema.optional),
  /** The role's job title, shown under its name in the roster ("Talent Scout", not "General Helper"). */
  title: Schema.String.pipe(Schema.optional),
  /** Who the agent IS, as opposed to what it does — layered into the prompt ahead of the job. Kept a
   *  separate field from `system` so the user can restyle a colleague without rewriting its remit. */
  personality: Schema.String.pipe(Schema.optional),
  /** The roster face: an emoji or a short glyph token. Colour stays in `color`. */
  avatar: Schema.String.pipe(Schema.optional),
  memory: Memory.pipe(Schema.optional),
  /** Keep compacted conversations in this colleague's own memory, so it can search them later when
   *  recall is not enough. Default ON (`undefined` = on) — the owner's rule is "unless the officer's
   *  settings disable it". Ignored for a throwaway, which keeps nothing by definition. */
  archiveChats: Schema.Boolean.pipe(Schema.optional),
  /**
   * The FOLDER this colleague works on — its project (owner, 2026-08-21).
   *
   * 🔴 A property of the COLLEAGUE, not of a chat. The prompt area used to ask which folder a new
   * chat should run in, which made "where does this work happen" a per-conversation question and left
   * a named officer with no project of its own. Under the roster it is part of the job: the
   * bookkeeper works on the books, and you assign it there once.
   *
   * Absent = the colleague's own scratch folder (`Scratch.forAgent`), so every officer always has a
   * real place to work without the user having to choose one.
   *
   * ⚠️ Changing it MESSAGES the colleague (`AgentWorkspace.reassignmentNotice`): an agent told
   * nothing would go on describing the project it was moved off, and a stale mental model is worse
   * than an interruption.
   */
  directory: Schema.String.pipe(Schema.optional),
  /**
   * How this colleague WORKS — three standing choices that were per-chat chips until 2026-08-21
   * (owner: *"the Chat/Agent drop down… same with Strict… and with permissions, which should be part
   * of the agent too"*).
   *
   * 🔴 They belong to the ROLE, not to a conversation. A bookkeeper that needs Analyze mode needs it
   * every time you talk to it, and re-choosing on every chat is the same defect the folder chip had:
   * a question the user answers again for a decision that never changes. Absent = inherit, exactly as
   * a session's own row does, so a chat can still differ when the user says so in that chat.
   *
   * ⚠️ Folded as a LAYER (`AgentDefaults.fold`), never stamped onto a session row — a colleague
   * reconfigured today changes what its next turn resolves, and a chat still distinguishes "you chose
   * this here" from "this is how this colleague works".
   */
  permissionMode: Schema.Literals(["plan", "ask", "bypass", "yolo"]).pipe(Schema.optional),
  /**
   * Strict, as the same OVERRIDE the session row carries — `{ enabled, attempts, wallMinutes }`,
   * every field optional.
   *
   * ⚠️ NOT a bare boolean, and the typecheck is what said so: the resolved config's `strict` is an
   * object, so a colleague declaring `true` would have folded a boolean into a field every reader
   * treats as a record. A colleague's standing choice has to speak the same language as the layer it
   * sits in, or the layering is a type error waiting for a caller.
   */
  strict: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional),
    attempts: Schema.Number.pipe(Schema.optional),
    wallMinutes: Schema.Number.pipe(Schema.optional),
  }).pipe(Schema.optional),
  /** The Chat/Agent posture: `true` = the fast local Chat stance, no project access or memory. */
  shortChat: Schema.Boolean.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}
