export * as WorkerControl from "./worker-control"

import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionPatch } from "./patch"
import { SessionSchema } from "./schema"
import type { SessionStore } from "./store"

/** Host-side worker kill. Stop the tree before taking the archive snapshot, so a final child
 * spawned while interruption settles cannot survive as an unarchived quota entry. */
export const kill = (input: {
  readonly parentID: SessionSchema.ID
  readonly childID: SessionSchema.ID
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const child = yield* input.store.get(input.childID)
    if (child?.parentID !== input.parentID) return undefined
    yield* input.interrupt(input.childID)
    const archived = DateTime.makeUnsafe(Date.now())
    const visited = new Set<SessionSchema.ID>()
    const pending = [input.childID]
    while (pending.length > 0) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      pending.push(...(yield* input.store.children(id)))
      yield* SessionPatch.patchSessionRecord(input, id, (info) =>
        info.time.archived === undefined
          ? SessionSchema.Info.make({ ...info, time: { ...info.time, archived } })
          : undefined,
      )
    }
    return visited.size
  })
