import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { NudgeService } from "@novaclaw/core/nudge-service"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionInputTable, SessionTable } from "@novaclaw/core/session/sql"
import { isSteerText, stripSteerProvenance } from "@novaclaw/core/session/steer-provenance"
import { ScratchHorizon } from "@novaclaw/core/scratch/horizon"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, NudgeService.node])),
)

it.effect("cleanup delivery is a durable, folded chat check and retry does not duplicate it", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const nudges = yield* NudgeService.Service
    const sessionID = SessionSchema.ID.make("ses_cleanup")
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        agent: "cleanup",
        slug: "cleanup",
        title: "Cleanup",
        directory: process.cwd(),
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const text = ScratchHorizon.noticeText("C:/scratch/cleanup/trash-list.txt", 3)
    const delivery = nudges.deliverScheduled({
      sessionID,
      sessionEpoch: 1,
      scheduleID: "scratch-horizon:cleanup",
      occurrence: "cycle-1",
      text,
      admittedAt: 2,
      admit: (id, text) =>
        SessionInput.admit(db, events, {
          id,
          sessionID,
          prompt: { text, files: [], agents: [], origin: undefined },
          delivery: "steer",
        }).pipe(Effect.map((admitted) => admitted.sessionID)),
    })
    yield* delivery.pipe(Effect.orDie)
    yield* delivery.pipe(Effect.orDie)
    const rows = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe(sessionID)
    expect(rows[0]!.delivery).toBe("steer")
    expect(isSteerText(rows[0]!.prompt.text)).toBe(true)
    expect(stripSteerProvenance(rows[0]!.prompt.text)).toBe(text)
  }),
)
