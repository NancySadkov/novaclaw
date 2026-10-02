import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionMessageTable } from "@novaclaw/core/session/sql"
import {
  HARNESS_SESSION,
  drive,
  makeLatch,
  makeRunnerHarness,
} from "./fixture/runner-harness"
import { fragmentFixture } from "./fixture/fragments"

/**
 * `Compact Now` — the manual fold — over a transcript that was SEEDED, not produced by a turn.
 *
 * 🔴 Why seeded rather than prompted. A drain that ends without `exit` self-drives (`drive.ts`
 * `INTERACTIVE_CONTINUE`), so priming a conversation with `session.prompt` leaves the harness looping
 * and the case wedges before it ever reaches the button. The manual fold runs NO turn — it is a
 * compact-only cycle — so seeding the history directly is both the faithful setup and the only one
 * that exercises the button without the drain's drive in the way.
 *
 * The claim: `session.compact` over a full transcript commits a compaction — the marker is consumed,
 * the summariser is spent once, and a compaction message lands. The regression this guards is the
 * compact-only cycle handing the compactor an EMPTY transcript and declining "nothing to fold" (a
 * 204 from the endpoint, `compacted: false`, and a context that never shrinks).
 */
describe("SessionRunnerLLM — Compact Now", () => {
  test("a manual compact folds a seeded transcript instead of declining nothing-to-fold", async () => {
    const harness = makeRunnerHarness({
      turns: [fragmentFixture("text", "text-manual-summary", ["## Goal\n- Manual summary"]).completeEvents],
    })
    const started = makeLatch()
    const ended = makeLatch()
    let endedData: { reason?: string; text?: string } | undefined

    const { summaries, compactionMessages } = await drive(
      harness,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service

        // Three exchanges with enough text that a 4K window has something to fold and room to fold it.
        const filler = (label: string) => `${label} `.repeat(400)
        const rows = [
          { type: "user" as const, seq: 1, data: { type: "user", time: { created: 1 }, text: filler("first question") } },
          {
            type: "assistant" as const,
            seq: 2,
            data: {
              type: "assistant",
              time: { created: 2, completed: 2 },
              agent: "nova",
              model: { providerID: "harness", id: "harness-model", variant: "default" },
              content: [{ type: "text", id: "txt-2", text: filler("first answer") }],
            },
          },
          { type: "user" as const, seq: 3, data: { type: "user", time: { created: 3 }, text: filler("second question") } },
          {
            type: "assistant" as const,
            seq: 4,
            data: {
              type: "assistant",
              time: { created: 4, completed: 4 },
              agent: "nova",
              model: { providerID: "harness", id: "harness-model", variant: "default" },
              content: [{ type: "text", id: "txt-4", text: filler("second answer") }],
            },
          },
          { type: "user" as const, seq: 5, data: { type: "user", time: { created: 5 }, text: filler("third question") } },
          {
            type: "assistant" as const,
            seq: 6,
            data: {
              type: "assistant",
              time: { created: 6, completed: 6 },
              agent: "nova",
              model: { providerID: "harness", id: "harness-model", variant: "default" },
              content: [{ type: "text", id: "txt-6", text: filler("third answer") }],
            },
          },
        ]
        for (const row of rows)
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(`msg_seed_${row.seq}`),
              session_id: HARNESS_SESSION,
              type: row.type,
              seq: row.seq,
              time_created: row.seq,
              time_updated: row.seq,
              data: row.data as never,
            })
            .run()
            .pipe(Effect.orDie)

        const unsubscribe = yield* events.listen((event) => {
          if (event.type === SessionEvent.Compaction.Started.type) started.open()
          if (event.type === SessionEvent.Compaction.Ended.type) {
            endedData = event.data as { reason?: string; text?: string }
            ended.open()
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        // The 4K window is what makes the fold's budget reachable from a seeded transcript.
        harness.controls.currentModel = harness.makeModel("compact", { context: 4_000, output: 50 })
        harness.requests.length = 0

        yield* session.compact({ sessionID: HARNESS_SESSION })
        yield* Effect.promise(() => started.promise)
        yield* Effect.promise(() => ended.promise)

        const context = yield* store.context(HARNESS_SESSION)
        return {
          summaries: [...harness.requests],
          compactionMessages: context.filter((message) => message.type === "compaction"),
        }
      }),
      "claim — Compact Now folds a seeded transcript",
    )

    expect(endedData?.reason).toBe("manual")
    expect(summaries, "a manual compact spends exactly one summariser request").toHaveLength(1)
    expect(compactionMessages, "the fold must commit a compaction message, not decline").toHaveLength(1)
  })
})
