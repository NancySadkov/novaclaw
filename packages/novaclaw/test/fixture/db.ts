import { rm } from "fs/promises"
import { Database } from "@novaclaw/core/database/database"
import { disposeAllInstances } from "./fixture"

export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
  const dbPath = Database.path()
  await rm(dbPath, { force: true }).catch(() => undefined)
  await rm(`${dbPath}-wal`, { force: true }).catch(() => undefined)
  await rm(`${dbPath}-shm`, { force: true }).catch(() => undefined)
}

// V1-nuke slice D: the facade Session.Service died — route tests seed sessions by publishing the
// NATIVE record event (the projector writes the row; the durable event feeds sync history).
import { DateTime, Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Location } from "@novaclaw/core/location"

let seededSessions = 0
export function seedSessionRow(input?: { title?: string; directory?: string }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const id = SessionSchema.ID.make(`ses_test${String(++seededSessions).padStart(20, "0")}`)
    const directory = AbsolutePath.make(input?.directory ?? "C:/project")
    const now = DateTime.makeUnsafe(Date.now())
    const title = input?.title ?? "test"
    yield* events.publish(
      SessionRecordEvent.Created,
      {
        sessionID: id,
        info: SessionSchema.Info.make({
          id,
          slug: id,
          version: "test",
          title,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          location: Location.Ref.make({ directory }),
          time: { created: now, updated: now },
        }),
      },
      { location: Location.Ref.make({ directory }) },
    )
    return { id, title }
  })
}
