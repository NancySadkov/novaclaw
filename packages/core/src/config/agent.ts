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
  /** The role's job title, shown under its name in the roster ("Talent Scout", not "General Helper"). */
  title: Schema.String.pipe(Schema.optional),
  /** Who the agent IS, as opposed to what it does — layered into the prompt ahead of the job. Kept a
   *  separate field from `system` so the user can restyle a colleague without rewriting its remit. */
  personality: Schema.String.pipe(Schema.optional),
  /** The roster face: an emoji or a short glyph token. Colour stays in `color`. */
  avatar: Schema.String.pipe(Schema.optional),
  memory: Memory.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}
