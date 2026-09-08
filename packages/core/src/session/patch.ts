export * as SessionPatch from "./patch"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { fromRow } from "./info"

/**
 * Cycle-free session-row patch (cf. `createSessionRecord`): read the raw row, map it to the
 * full NATIVE `Session.Info` via `fromRow` (the `Updated` projector rewrites the WHOLE row, so
 * a partial payload would corrupt it), merge, publish the full-info `session.updated`
 * location-stamped. Shared by `SessionV2`'s setters and the runner's auto-title — the runner
 * cannot depend on `SessionV2.node` (it would close the cycle
 * `SessionV2 -> LocationServiceMap -> location services -> runner`).
 *
 * V1-nuke slice D: the merge callback and the event payload are the native shape; the V1 codec
 * (`v1InfoFromRow`) and the V1 wire event died with schema/v1.
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
  merge: (info: SessionSchema.Info) => SessionSchema.Info | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const row = yield* deps.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return false
    const next = merge(fromRow(row))
    if (next) {
      yield* deps.events.publish(
        SessionRecordEvent.Updated,
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
