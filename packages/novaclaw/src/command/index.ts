import { Schema } from "effect"

// P6 (ui-arch hardening, rides config-sqlite step 9): the V1 `Command.Service` map is retired —
// both /command routes serve the shared core `CommandList` union (CommandV2 ∪ skills ∪ MCP
// prompts) and dispatch rides the V2 session command op. What remains here is the V1 WIRE
// shape (`Info`, the legacy /command response) and the built-in command name constants.

export const Event = {
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

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export * as Command from "."
