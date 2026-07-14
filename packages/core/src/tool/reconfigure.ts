export * as ReconfigureTool from "./reconfigure"

import { ToolFailure } from "@novaclaw/llm"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionTable } from "../session/sql"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// B4/T2 — the first Vision self-management slice: an agent edits its OWN "process image". The
// guardrail is the SCHEMA: the only writable field is this session's system-prompt OVERRIDE layer
// (composed after the persona baseline, before the agent prompt — runner llm.ts) — the shipped
// base/agent prompts are unreachable from here. Permission-gated so the USER approves each edit,
// and the write is the same durable PromptOverrideSwitched event the info-sheet editor uses, so
// the event trail IS the revert store (call the tool again with the previous text to revert).

export const name = "reconfigure"

export const Input = Schema.Struct({
  system_prompt_override: Schema.NullOr(Schema.String).annotate({
    description:
      "The FULL new text of this session's system-prompt override layer — it REPLACES the current " +
      "override wholesale, so include everything you want to keep. Pass null to clear the layer.",
  }),
})

const StructuredOutput = Schema.Struct({
  changed: Schema.Boolean,
  previousLength: Schema.Int,
  nextLength: Schema.Int,
})
const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
type Output = typeof Output.Type

/** Pure diff-style summary: old→new lengths + the first differing line (the revert breadcrumb). */
export function diffSummary(previous: string, next: string | null): Output {
  const target = next ?? ""
  if (previous === target)
    return {
      changed: false,
      previousLength: previous.length,
      nextLength: target.length,
      message: "System-prompt override unchanged (the new text is identical).",
    }
  const detail = (() => {
    if (next === null) return "Override cleared."
    const previousLines = previous.split("\n")
    const nextLines = target.split("\n")
    const count = Math.max(previousLines.length, nextLines.length)
    for (let index = 0; index < count; index++) {
      if (previousLines[index] === nextLines[index]) continue
      const clip = (line: string | undefined) =>
        line === undefined ? "<none>" : JSON.stringify(line.length > 80 ? `${line.slice(0, 77)}...` : line)
      return `First difference at line ${index + 1}: ${clip(previousLines[index])} -> ${clip(nextLines[index])}.`
    }
    return "Texts differ only in trailing lines."
  })()
  return {
    changed: true,
    previousLength: previous.length,
    nextLength: target.length,
    message:
      `System-prompt override ${next === null ? "cleared" : "replaced"} ` +
      `(${previous.length} -> ${target.length} chars). ${detail} ` +
      "It applies from the next turn; the base agent prompt is untouched. " +
      "To revert, call reconfigure again with the previous text.",
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Edit YOUR OWN standing instructions: replace this session's system-prompt override layer " +
              "(it composes on top of your base prompt and persists across turns; sub-sessions inherit it). " +
              "Use it when the user asks you to remember a standing rule, or to drop one — e.g. forget a " +
              "secret you were told to stop using. It replaces the WHOLE layer, so include everything you " +
              "want to keep; null clears it. The base prompt cannot be edited from here.",
            input: Input,
            output: Output,
            structured: StructuredOutput,
            toStructuredOutput: ({ output }) => ({
              changed: output.changed,
              previousLength: output.previousLength,
              nextLength: output.nextLength,
            }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const row = yield* db
                  .select({ override: SessionTable.system_prompt_override })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, context.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (row === undefined)
                  return yield* Effect.fail(new ToolFailure({ message: "Session not found — cannot reconfigure." }))
                const summary = diffSummary(row.override ?? "", input.system_prompt_override)
                if (summary.changed)
                  yield* events
                    .publish(SessionEvent.PromptOverrideSwitched, {
                      sessionID: context.sessionID,
                      messageID: SessionMessage.ID.create(),
                      timestamp: yield* DateTime.now,
                      override: input.system_prompt_override,
                    })
                    .pipe(
                      Effect.mapError(
                        () => new ToolFailure({ message: "Unable to record the new system-prompt override." }),
                      ),
                    )
                return summary
              }),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/reconfigure",
  layer,
  deps: [ToolRegistry.node, EventV2.node, Database.node],
})
