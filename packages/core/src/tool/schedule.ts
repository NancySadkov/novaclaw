export * as ScheduleTool from "./schedule"

import { ToolFailure } from "@novaclaw/llm"
import { Clock, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { ScheduleStore } from "../schedule/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "schedule"

export const Input = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({ op: Schema.Literal("confirm"), scheduleId: Schema.String, occurrenceMillis: Schema.Finite }),
  Schema.Struct({ op: Schema.Literal("disable"), scheduleId: Schema.String }),
])
export const Output = Schema.String

export const metadata = {
  description:
    "List your scheduled work, confirm one active window complete, or disable a recurring schedule. A schedule nudge gives the scheduleId and occurrenceMillis needed for confirmation.",
  input: Input,
  output: Output,
  sideEffect: "idempotent-write",
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const { db } = yield* Database.Service
    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            execute: (input, context) =>
              Effect.gen(function* () {
                const agentID = String(context.agent)
                if (input.op === "list") {
                  const schedules = yield* ScheduleStore.listForAgent(db, agentID)
                  const windows = yield* ScheduleStore.recentFiresForAgent(db, agentID)
                  return JSON.stringify({ schedules, windows })
                }
                const now = yield* Clock.currentTimeMillis
                if (input.op === "disable") {
                  const disabled = yield* ScheduleStore.updateForAgent(db, agentID, input.scheduleId, { enabled: false }, now)
                  if (!disabled) return yield* new ToolFailure({ message: "No schedule with that id belongs to you." })
                  return `Schedule ${input.scheduleId} disabled. No future windows will open.`
                }
                const confirmed = yield* ScheduleStore.confirmForAgent(
                  db,
                  agentID,
                  input.scheduleId,
                  input.occurrenceMillis,
                  now,
                )
                if (confirmed === undefined)
                  return yield* new ToolFailure({ message: "This scheduled window is no longer open for confirmation." })
                return JSON.stringify(confirmed)
              }),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/schedule",
  layer,
  deps: [ToolRegistry.node, Database.node],
})
