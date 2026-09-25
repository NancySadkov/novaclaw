export * as Workers from "./workers"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionExecutionTable, SessionTable } from "./sql"
import { WorkerPurpose } from "./worker-purpose"

export const State = Schema.Literals(["starting", "busy", "recovering", "paused", "queued"])
export type State = typeof State.Type

export const Item = Schema.Struct({
  id: Schema.String,
  purpose: Schema.String,
  state: State,
  startedAt: Schema.Number,
})
export type Item = typeof Item.Type

const livingState = (state: string | null): State | undefined => {
  if (state === null) return "queued"
  if (state === "starting" || state === "busy" || state === "recovering" || state === "paused") return state
  return undefined
}

export const list = Effect.fn("Workers.list")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
}) {
  const rows = yield* input.db
    .select({
      id: SessionTable.id,
      type: SessionTable.type,
      title: SessionTable.title,
      metadata: SessionTable.metadata,
      result: SessionTable.result,
      archivedAt: SessionTable.time_archived,
      createdAt: SessionTable.time_created,
      state: SessionExecutionTable.state,
    })
    .from(SessionTable)
    .leftJoin(SessionExecutionTable, eq(SessionExecutionTable.session_id, SessionTable.id))
    .where(eq(SessionTable.parent_id, input.sessionID))
    .all()
    .pipe(Effect.orDie)

  return rows
    .flatMap((row): Item[] => {
      const state = livingState(row.state)
      if (row.type !== "sub-agent" || row.archivedAt !== null || row.result !== null || state === undefined) return []
      return [{
        id: row.id,
        purpose: WorkerPurpose.fromMetadata(row.metadata) ?? row.title,
        state,
        startedAt: row.createdAt,
      }]
    })
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
})
