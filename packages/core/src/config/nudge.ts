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
  /**
   * **Opt out of the quiet rule.** Absent means quiet.
   *
   * A quiet nudge reaches a session at most once per 30 minutes AND at most once per context epoch
   * (compaction), whichever is later. That is what makes a trigger that fires on every matching edit
   * — a text-match on timestamp arithmetic, say — deliver once instead of filling the transcript
   * with the same paragraph. `Spammable` is for the nudges whose repetition IS the payload: a
   * heartbeat that reports a changing count, for instance. It is opt-in because the quiet rule is
   * the behaviour every nudge wants unless its author says otherwise.
   */
  spammable: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Repeat as often as the trigger fires. Off by default: a nudge is delivered at most once per 30 minutes and at most once per context epoch.",
  }),
}) {}

export const List = Schema.Array(Info)
