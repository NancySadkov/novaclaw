export * as SessionPatch from "./patch"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionV1 } from "../v1/session"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { v1InfoFromRow } from "./info"

/**
 * Cycle-free session-row patch (cf. `createSessionRecord`): read the raw row, map it to the
 * full legacy `SessionV1.SessionInfo` via `v1InfoFromRow` (the `Updated` projector rewrites
 * the WHOLE row, so a partial payload would corrupt it), merge, publish the full-info legacy
 * `session.updated` location-stamped. Shared by `SessionV2`'s setters and the runner's
 * auto-title — the runner cannot depend on `SessionV2.node` (it would close the cycle
 * `SessionV2 -> LocationServiceMap -> location services -> runner`).
 *
 * Returns false when the session row is missing; `merge` returning undefined is a dedup
 * no-op (publishes nothing, returns true).
 */
export const patchSessionRecord = (
  deps: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
  },
  sessionID: SessionSchema.ID,
  merge: (info: SessionV1.SessionInfo) => SessionV1.SessionInfo | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const row = yield* deps.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return false
    const next = merge(v1InfoFromRow(row))
    if (next) {
      yield* deps.events.publish(
        SessionV1.Event.Updated,
        { sessionID, info: next },
        {
          location: Location.Ref.make({
            directory: AbsolutePath.make(row.directory),
            workspaceID: row.workspace_id ?? undefined,
          }),
        },
      )
    }
    return true
  })
