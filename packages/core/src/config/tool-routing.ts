export * as ConfigToolRouting from "./tool-routing"

import { Schema } from "effect"

export const Mode = Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"])
export type Mode = typeof Mode.Type

/**
 * One ordered routing rule. Selectors are case-insensitive substrings so a family rule can cover
 * several catalog entries without duplicating them. Omitted selectors match every turn.
 *
 * `tools` is deliberately a boolean record rather than separate enable/disable arrays: a tool has
 * one decision per rule, and later matching rules replace earlier decisions without an ambiguous
 * order inside one rule.
 */
export class Rule extends Schema.Class<Rule>("ConfigV2.ToolRouting.Rule")({
  mode: Mode.pipe(Schema.optional),
  provider: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  tools: Schema.Record(Schema.String, Schema.Boolean),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.ToolRouting")({
  rules: Schema.Array(Rule),
}) {}

export interface Target {
  readonly mode: Mode
  readonly providerID: string
  readonly modelID: string
}

/**
 * Tools this table may never withdraw.
 *
 * 🔴 **Without this, a routing rule could switch off the tool the instance is repaired WITH.** This
 * table is an arbitrary `{name: false}` map an agent can write (`tool_routing` is `consequential`,
 * so one `configure` card grants it), and the tier table's own note admitted the hazard in passing:
 * *"can change a model's working set or strand its repair tool"*. Stranding it is not a degraded
 * mode, it is the end of AGENTS.md's self-healing law — *as long as at least one working model
 * remains, the system must be restorable by asking an agent* — because the agent you would ask no
 * longer has the tool. A config store you can only break in one direction is exactly what that law
 * exists to prevent.
 *
 * ⚠️ **Deliberately minimal, and it should stay that way.** Every name here is a tool the USER can
 * no longer turn off for a model that misuses it, so the bar is "repair is impossible without it",
 * not "repair is easier with it". `configure` clears that bar alone: it is the write path to every
 * runtime-editable store, including this table, so it is the one tool whose loss cannot be undone
 * from inside. Read/search/edit tools do not — a stranded instance with `configure` can restore
 * them; a stranded instance without it cannot restore anything.
 *
 * This is a FLOOR under routing only. It grants nothing: the caller applies this predicate to
 * registrations that already survived the permission filter, so a tool the permission model
 * withdrew stays withdrawn, and an agent cannot reach `configure` by being unable to disable it.
 */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set(["configure"])

/**
 * Compile an ordered table into a pure horizon predicate.
 *
 * The default is offered, preserving the existing catalog. A `true` decision can only undo an
 * earlier ROUTING decision: the caller applies this predicate to registrations that survived the
 * permission filter, so it cannot add an unregistered or permission-withdrawn tool.
 */
export const offered = (info: Info | undefined, target: Target) => {
  const decisions = new Map<string, boolean>()
  for (const rule of info?.rules ?? []) {
    if (!matches(rule, target)) continue
    for (const [name, enabled] of Object.entries(rule.tools)) decisions.set(name, enabled)
  }
  return (name: string): boolean => (ESSENTIAL_TOOLS.has(name) ? true : (decisions.get(name) ?? true))
}

const matches = (rule: Rule, target: Target): boolean =>
  (rule.mode === undefined || rule.mode === target.mode) &&
  includes(target.providerID, rule.provider) &&
  includes(target.modelID, rule.model)

const includes = (value: string, selector: string | undefined): boolean =>
  selector === undefined || value.toLowerCase().includes(selector.toLowerCase())
