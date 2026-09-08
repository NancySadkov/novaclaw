// A FORK CARRIES ITS SOURCE'S CONTEXT STATE, NOT JUST ITS TRANSCRIPT.
//
// 🔴 `fork` copied every row of `SessionMessageTable` and stopped there. The compaction overlay does
// not live in that table — `Compaction.Ended` projects into `session_compaction`, and
// `SessionHistory` synthesises the overlay from there — so the fork got no overlay row,
// `latestCompaction` returned `undefined`, and the fork's first turn assembled the FULL raw history
// its source had already summarised away. On a small model that is the context overflow this harness
// exists to prevent.
//
// ⚠️ Measured, never asserted as a flag: the claim is "the fork loads the compacted context", and a
// row existing is not that claim. Every assertion below counts messages or characters.

import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionHistory } from "@novaclaw/core/session/history"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionProjector } from "@novaclaw/core/session/projector"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionMessageTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

const rootAgent = AgentV2.ID.make("build")
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const created = DateTime.makeUnsafe(1)

/** Long enough that "summarised away" and "still raw" are separated by a wide margin in characters. */
const BODY = "detail ".repeat(400)

const say = (sessionID: SessionSchema.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.MessageRecorded, {
      sessionID,
      timestamp: created,
      message: SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created },
      }),
    })
  })

const rawSeqs = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)).map((row) => row.seq)
  })

const loaded = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* SessionHistory.load(db, sessionID)
  })

const chars = (messages: readonly SessionMessage.Message[]) => JSON.stringify(messages).length

/** Six raw messages, then an overlay that folds the first four away. */
const compactedSource = (title: string) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const source = yield* session.create({ location, agent: rootAgent, title })
    for (const index of [1, 2, 3, 4, 5, 6]) yield* say(source.id, `message ${index} ${BODY}`)
    const seqs = yield* rawSeqs(source.id)
    const prefixSeq = seqs[3]!
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID: source.id,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(2),
      reason: "auto",
      text: "SUMMARY of the first four messages",
      recent: "the tail, verbatim",
      prefixSeq,
      prefixHash: yield* SessionHistory.prefixHash(db, source.id, prefixSeq),
    })
    return { source, seqs, prefixSeq }
  })

describe("forking a chat that has already compacted", () => {
  it.effect("the fork loads the SUMMARY, not the whole raw transcript", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { source } = yield* compactedSource("compacted source")

      const sourceLoaded = yield* loaded(source.id)
      // The source itself runs on 1 overlay + 2 tail messages, not its 6 raw rows.
      expect(sourceLoaded.map((message) => message.type)).toEqual(["compaction", "user", "user"])

      const forked = yield* session.fork({ sessionID: source.id })

      // ① The TRANSCRIPT is still copied in full — this fix must not have traded one loss for another.
      expect((yield* rawSeqs(forked.id)).length).toBe((yield* rawSeqs(source.id)).length)

      // ② …and the CONTEXT the fork would run a turn on is the source's, message for message.
      const forkLoaded = yield* loaded(forked.id)
      expect(forkLoaded.map((message) => message.type)).toEqual(sourceLoaded.map((message) => message.type))
      expect(forkLoaded.length).toBe(3)

      // ③ Measured, not flagged: before this fix the fork loaded all six raw messages, which is
      // roughly twice the characters. The margin is what the small model actually pays.
      const rawCharacters = chars(
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, forked.id))
            .orderBy(asc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows.map((row) => row.data) as unknown as SessionMessage.Message[]
        }),
      )
      expect(chars(forkLoaded)).toBeLessThan(rawCharacters / 2)

      // ④ The summary itself travelled, and it is the SOURCE's text rather than a fresh one.
      expect(JSON.stringify(forkLoaded[0])).toContain("SUMMARY of the first four messages")
      expect(JSON.stringify(forkLoaded[0])).toContain("the tail, verbatim")
    }),
  )

  /**
   * 🔴 THE CONTROL. An overlay is carried only when there IS one — a fork that fabricates one, or
   * copies a neighbour's, would pass every assertion above. A chat that never compacted must load
   * every raw message it holds.
   */
  it.effect("a fork of an UNCOMPACTED chat still loads its whole transcript", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const source = yield* session.create({ location, agent: rootAgent, title: "plain source" })
      for (const index of [1, 2, 3]) yield* say(source.id, `plain ${index}`)

      const forked = yield* session.fork({ sessionID: source.id })
      const forkLoaded = yield* loaded(forked.id)
      expect(forkLoaded.map((message) => message.type)).toEqual(["user", "user", "user"])
      expect(forkLoaded.length).toBe((yield* rawSeqs(forked.id)).length)
    }),
  )

  /**
   * ⚠️ The boundary case, and the reason the seqs are re-mapped rather than copied. Forking BEFORE
   * the summarised span means the fork does not hold the messages the overlay claims to replace, so
   * carrying it would hand the fork a summary of a transcript it never had.
   */
  it.effect("forking before the summarised span carries no overlay", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const { source } = yield* compactedSource("boundary source")
      const rows = yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, source.id))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)

      // Fork strictly before the third message: the overlay's prefix reaches past this point.
      const forked = yield* session.fork({ sessionID: source.id, messageID: rows[2]!.id })
      const forkLoaded = yield* loaded(forked.id)
      expect(forkLoaded.map((message) => message.type)).toEqual(["user", "user"])
      expect(forkLoaded.length).toBe((yield* rawSeqs(forked.id)).length)
    }),
  )
})
