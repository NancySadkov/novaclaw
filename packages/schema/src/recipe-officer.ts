import { Schema } from "effect"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000))
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
export const RecipeNudge = Schema.Struct({
  name: Label,
  text: Text,
  hook: Schema.Union([
    Schema.Struct({ type: Schema.Literal("after-compaction") }),
    Schema.Struct({ type: Schema.Literal("new-day") }),
    Schema.Struct({
      type: Schema.Literal("interval"),
      minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
    }),
    Schema.Struct({ type: Schema.Literal("tool-call"), tool: Label, phase: Schema.Literals(["before", "after"]) }),
    Schema.Struct({ type: Schema.Literal("file-write"), extension: Label }),
  ]),
})
export type RecipeNudge = typeof RecipeNudge.Type
export const RecipeOfficer = Schema.Struct({
  title: Label,
  description: Text,
  nudges: Schema.Array(RecipeNudge).check(Schema.isMaxLength(32)),
})
export type RecipeOfficer = typeof RecipeOfficer.Type
export const RecipeOfficers = Schema.Array(RecipeOfficer).check(Schema.isMaxLength(16))

export function decodeRecipeOfficers(value: unknown): readonly RecipeOfficer[] {
  const officers = Schema.decodeUnknownSync(RecipeOfficers, { onExcessProperty: "error" })(value)
  for (const officer of officers) {
    if (!officer.title.trim() || !officer.description.trim())
      throw new Error("Each officer needs a job title and description.")
    for (const nudge of officer.nudges)
      if (!nudge.name.trim() || !nudge.text.trim()) throw new Error("Each nudge needs a name and instruction.")
  }
  return officers
}
