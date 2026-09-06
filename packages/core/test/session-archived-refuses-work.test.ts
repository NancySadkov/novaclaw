import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { AbsolutePath } from "@novaclaw/core/schema"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

/**
 * A FILED CHAT IS NOT A PLACE WORK HAPPENS.
 *
 * Owner, 2026-09-03, on being told the client fix left this open: *"is this the most perfect
 * architectural solution according to our vision?"* It was not. The tab following its colleague
 * closed ONE door; the CLI, the HTTP API, a colleague's `ask`, a scheduled task and every
 * integration reach this same seam and none of them knew. AGENTS.md: impossible > caught > named,
 * and a guard living in one caller is the middle rung wearing the top one's clothes.
 *
 * What made it necessary, measured on the owner's instance: reassignment archived a colleague's chat
 * and opened a successor, correctly. The client stayed pinned to the predecessor, which then took
 * **296 more events over three minutes** — a file written and compiled into the colleague's scratch,
 * and a write to the real project refused, because that session's root really was scratch. Every
 * layer behaved as written and the user got work in the wrong place with no way to see why.
 */
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
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
const colleague = AgentV2.ID.make("daedalus")

describe("a prompt aimed at an archived session", () => {
  it.effect("🔴 is REFUSED, and the refusal names the colleague's current chat", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const filed = yield* sessions.create({ location, agent: colleague, title: "before the move" })
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })
      // The returning colleague reclaims its canonical id; the archived transcript gets a history id.
      const successor = yield* sessions.create({ location, agent: colleague, title: "after the move" })
      const history = (yield* sessions.list({ directory: location.directory })).find(
        (session) => session.title === "before the move",
      )
      expect(history?.time.archived).toBeDefined()
      expect(history?.id).not.toBe(successor.id)

      const outcome = yield* sessions
        .prompt({ sessionID: history!.id, prompt: { text: "write hello.c here" } })
        .pipe(Effect.exit)

      expect(Exit.isFailure(outcome)).toBe(true)
      const error = Exit.isFailure(outcome) ? Option.getOrUndefined(Cause.findErrorOption(outcome.cause)) : undefined
      expect((error as { _tag?: string })?._tag).toBe("Session.ArchivedError")
      const archived = error as SessionV2.SessionArchivedError
      expect(archived.sessionID).toBe(history!.id)
      // The remedy, not just the refusal: every caller that can retry can retry there.
      expect(archived.successorID).toBe(successor.id)
    }),
  )

  it.effect("CONTROL — a LIVE session still takes the same prompt", () =>
    Effect.gen(function* () {
      // Without this the file would pass on a kernel that refused every prompt ever sent, which is
      // the failure mode a one-sided refusal test cannot see.
      const sessions = yield* SessionV2.Service
      const live = yield* sessions.create({ location, agent: colleague, title: "working" })
      const admitted = yield* sessions.prompt({ sessionID: live.id, prompt: { text: "write hello.c here" } })
      expect(admitted).toBeDefined()
    }),
  )

  it.effect("a colleague with NO live chat is told so, rather than sent somewhere invented", () =>
    Effect.gen(function* () {
      // A retirement. There is genuinely nowhere for this to go, and saying that is the honest
      // answer — a successor id pointing at nothing would be worse than none.
      const sessions = yield* SessionV2.Service
      const filed = yield* sessions.create({ location, agent: AgentV2.ID.make("myron"), title: "retired" })
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })

      const outcome = yield* sessions.prompt({ sessionID: filed.id, prompt: { text: "anything" } }).pipe(Effect.exit)

      expect(Exit.isFailure(outcome)).toBe(true)
      const error = Exit.isFailure(outcome) ? Option.getOrUndefined(Cause.findErrorOption(outcome.cause)) : undefined
      expect((error as { _tag?: string })?._tag).toBe("Session.ArchivedError")
      expect((error as SessionV2.SessionArchivedError).successorID).toBeUndefined()
    }),
  )
})
