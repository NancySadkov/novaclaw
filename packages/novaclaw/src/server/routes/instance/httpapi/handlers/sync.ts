import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { Log } from "@novaclaw/schema/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@novaclaw/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SessionPatch } from "@novaclaw/core/session/patch"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { Location } from "@novaclaw/core/location"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).origin)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Log.event("workspace.sync.replay.start", {
        "session.id": source,
        "workspace.events": payload.length,
        "workspace.sequence.first": payload[0].seq,
        "workspace.sequence.last": payload.at(-1)!.seq,
        "workspace.directory": ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Log.event("workspace.sync.replay.ok", {
        "session.id": source,
        "workspace.events": payload.length,
        "workspace.sequence.first": payload[0].seq,
        "workspace.sequence.last": payload.at(-1)!.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      // V1-nuke slice D: the workspace steal writes through the native patch seam (the V1
      // Session.Service facade retired wholesale).
      yield* SessionPatch.patchSessionRecord({ db, events }, SessionSchema.ID.make(ctx.payload.sessionID), (info) =>
        SessionSchema.Info.make({
          ...info,
          location: Location.Ref.make({ directory: info.location.directory, workspaceID }),
        }),
      )

      yield* Log.event("workspace.session.steal", { "session.id": ctx.payload.sessionID, "workspace.id": workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      return yield* db
        .select()
        .from(EventTable)
        .where(
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined,
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)
