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
])
export const Output = Schema.String

export const metadata = {
  description:
    "List your scheduled work or confirm one active work window complete. A schedule nudge gives the scheduleId and occurrenceMillis needed for confirmation. Each overlapping task must be confirmed separately.",
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
