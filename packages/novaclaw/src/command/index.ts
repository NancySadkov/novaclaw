import { Schema } from "effect"
import { LegacyEvent } from "@novaclaw/schema/legacy-event"

// P6 (ui-arch hardening, rides config-sqlite step 9): the V1 `Command.Service` map is retired —
// the `/command` list serves the V2 truth (`CommandV2` ∪ skills ∪ the MCP
// `ExternalCommandSource`) and dispatch already rode the V2 session command op. What remains
// here is the V1 WIRE shape (`Info`, the /command response the app consumes), the placeholder
// `hints` extractor shared by the list handler, and the built-in command name constants.

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export * as Command from "."
