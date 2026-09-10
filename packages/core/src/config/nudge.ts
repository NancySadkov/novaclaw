export * as ConfigNudge from "./nudge"

import { Schema } from "effect"

export const Hook = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-match"), pattern: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call"), tool: Schema.String }),
  Schema.Struct({ type: Schema.Literal("mcp-call"), server: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file-read"), extension: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file-write"), extension: Schema.String }),
  Schema.Struct({ type: Schema.Literal("after-compaction") }),
  Schema.Struct({ type: Schema.Literal("resource-pressure"), level: Schema.Literals(["warning", "floor", "either"]) }),
  Schema.Struct({ type: Schema.Literal("time-of-day"), after: Schema.String, before: Schema.String }),
  Schema.Struct({ type: Schema.Literal("new-day") }),
  Schema.Struct({ type: Schema.Literal("script"), command: Schema.String }),
]).annotate({ description: "A harness-owned event selector. Script hooks fire when their command exits successfully." })
export type Hook = typeof Hook.Type

export class Info extends Schema.Class<Info>("ConfigV2.Nudge")({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean.pipe(Schema.optional),
  hook: Hook,
  text: Schema.String,
  script: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional command whose bounded stdout is appended to the instruction at delivery time.",
  }),
}) {}

export const List = Schema.Array(Info)
