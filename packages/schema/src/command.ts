export * as Command from "./command"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  template: Schema.String,
  description: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  model: Model.Ref.pipe(optional),
  subtask: Schema.Boolean.pipe(optional),
  // P6 (/command reconciliation): presentation metadata the list routes project — where the
  // command came from (a saved command, an MCP prompt, a skill) and its argument placeholders
  // ($1..$N / $ARGUMENTS) for the composer. Absent on the raw CommandV2 state entries; the
  // list handlers fill them.
  source: Schema.Literals(["command", "mcp", "skill"]).pipe(optional),
  hints: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "CommandV2.Info" })
