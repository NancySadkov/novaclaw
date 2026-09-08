export * as ConfigNudge from "./nudge"

import { Schema } from "effect"

const agents = Schema.Array(Schema.String).pipe(Schema.optional).annotate({
  description: "Agent ids this nudge applies to. Absent or empty means every agent.",
})

export const Hook = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-match"), pattern: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call"), tool: Schema.String }),
  Schema.Struct({ type: Schema.Literal("mcp-call"), server: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file-read"), extension: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file-write"), extension: Schema.String }),
  Schema.Struct({ type: Schema.Literal("after-compaction") }),
  Schema.Struct({ type: Schema.Literal("resource-pressure"), level: Schema.Literals(["warning", "floor", "either"]) }),
  Schema.Struct({ type: Schema.Literal("time-of-day"), after: Schema.String, before: Schema.String }),
]).annotate({ description: "A closed, harness-owned event selector. Free-form code is never executed." })
export type Hook = typeof Hook.Type

export class Info extends Schema.Class<Info>("ConfigV2.Nudge")({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean.pipe(Schema.optional),
  agents,
  hook: Hook,
  text: Schema.String,
}) {}

export const List = Schema.Array(Info)
