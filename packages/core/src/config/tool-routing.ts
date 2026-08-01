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
  return (name: string): boolean => decisions.get(name) ?? true
}

const matches = (rule: Rule, target: Target): boolean =>
  (rule.mode === undefined || rule.mode === target.mode) &&
  includes(target.providerID, rule.provider) &&
  includes(target.modelID, rule.model)

const includes = (value: string, selector: string | undefined): boolean =>
  selector === undefined || value.toLowerCase().includes(selector.toLowerCase())
