import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AbsolutePath } from "@novaclaw/core/schema"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
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
 * **A PROMPT IS NEVER REFUSED FOR THE STATE OF THE CHAT IT NAMES.**
 *
 * Owner, 2026-09-04, on being shown the refusal a live instance produced: *"Please ensure this error
 * is impossible at architecture level as per our vision in AGENTS.md. I.e. the prompt is always
 * accepted, and queued if can't be inserted immediately, and the colleague always has a chat (by
 * architecture)."*
 *
 * What the user actually saw, by typing into a colleague's chat:
 *
 *     Failed to send prompt
 *     This conversation has been filed and does not take new messages, and its colleague has no
 *     current chat.
 *
 * The second half of that sentence is the defect stated out loud. A colleague's chat is created
 * LAZILY — `createSessionRecord` mints it the first time something asks for one — so between Clear
 * chat, a reassignment and a fresh hire there is a window in which it does not exist, and every one
 * of those is an ordinary thing a user does. The sentence was true and the situation was ours.
 *
 * The previous behaviour, and the test that pinned it, refused the prompt and named a successor for
 * the caller to retry at. That closed a real hole (the CLI, the HTTP API, a colleague's `ask` and
 * every integration reached the same seam and none of them knew the chat had been replaced) but it
 * closed it at the middle rung of AGENTS.md's *impossible > caught > named*: the refusal still
 * reached a person. The resolution now happens at the seam.
 *
 * AGENTS.md states the rule this restores: *"A component does not get an identity of its own; it is
 * reached through its entity."* A chat is a component of a colleague. A prompt aimed at a filed chat
 * is still addressed to the COLLEAGUE, and it goes to the colleague's chat — which always exists.
 */
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentConfigStore.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)

/** A colleague the store knows about — the same fact `agent.remove` takes away on a retirement. */
const hire = (agent: string) =>
  Effect.gen(function* () {
    const store = yield* AgentConfigStore.Service
    yield* store.setLayers(agent, [decodeAgent({ name: AgentV2.ID.make(agent) })])
  })

describe("a prompt aimed at a filed chat", () => {
  it.effect("🔴 is ADMITTED into the colleague's current chat, not refused", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* hire("daedalus")
      const filed = yield* sessions.create({ location, agent: AgentV2.ID.make("daedalus"), title: "before the move" })
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })
      // The returning colleague reclaims its canonical id; the archived transcript gets a history id.
      const successor = yield* sessions.create({
        location,
        agent: AgentV2.ID.make("daedalus"),
        title: "after the move",
      })
      const history = (yield* sessions.list({ directory: location.directory })).find(
        (session) => session.title === "before the move",
      )
      expect(history?.time.archived).toBeDefined()
      expect(history?.id).not.toBe(successor.id)

      const admitted = yield* sessions.prompt({ sessionID: history!.id, prompt: { text: "write hello.c here" } })

      // The words landed, in the colleague's chat, and the answer SAYS where — so a caller that
      // wants to follow the work can, and one that does not still got its prompt delivered.
      expect(admitted.sessionID).toBe(successor.id)
      expect(admitted.prompt.text).toBe("write hello.c here")
    }),
  )

  it.effect("🔴 IS ACCEPTED EVEN WHEN THE COLLEAGUE HAS NO CHAT — the reported failure", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* hire("umbris")
      const filed = yield* sessions.create({ location, agent: AgentV2.ID.make("umbris"), title: "the only chat" })
      // The window this test exists for: the colleague's chat is filed and NO successor was ever
      // opened — a Clear chat whose replacement has not been minted yet, or a reassignment whose
      // successor insert did not land. Until this change the user was told there was nowhere to go.
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })
      expect(
        (yield* sessions.list({ directory: location.directory })).every((row) => row.time.archived !== undefined),
      ).toBe(true)

      const admitted = yield* sessions.prompt({ sessionID: filed.id, prompt: { text: "still here?" } })

      expect(admitted.prompt.text).toBe("still here?")
      // And the colleague HAS a chat now — the invariant the owner asked for, reached by asking for
      // it rather than by a caller remembering to open one. It is opened where the colleague WORKS
      // (`AgentWorkspace.folderFor`: its configured folder, or its own scratch), not where the chat
      // it replaced happened to be — which is the whole point of the successor after a reassignment.
      const all = yield* sessions.list()
      const live = all.filter(
        (row) => row.time.archived === undefined && row.parentID === undefined && row.agent === "umbris",
      )
      expect(live.length).toBe(1)
      expect(live[0]!.id).toBe(admitted.sessionID)
      // ⚠️ The filed transcript SURVIVES — re-keyed to a history id, because the colleague's canonical
      // `ses_<agent>` seat is the live chat's and a returning name must never open into the old
      // conversation. Which is also why `admitted.sessionID` equals the id the caller named: the seat
      // did not move, its occupant did. A stale tab therefore lands in the right chat with no retry.
      const filedRow = yield* sessions.get(filed.id)
      expect(filedRow.time.archived).toBeUndefined()
      const history = all.find((row) => row.time.archived !== undefined)
      expect(history).toBeDefined()
      expect(history!.title).toBe("the only chat")
    }),
  )

  it.effect("a chat NOBODY live owns is brought back, and is never left owned by a retired id", () =>
    Effect.gen(function* () {
      // A retirement archives the colleague's chats and deletes its config row. There is no entity to
      // resolve through, so the chat the caller NAMED is the address — filed is a state the user put
      // it in, and typing into it is the user asking for it not to be.
      //
      // ⚠️ The owner is re-stamped to a POSTURE. Leaving the retired id on a LIVE root is the bleed
      // `agent/retire.ts` archives chats to prevent: officer names come from a fixed pool, so the next
      // colleague drawn on that name would be handed this transcript as its own.
      const sessions = yield* SessionV2.Service
      const filed = yield* sessions.create({ location, agent: AgentV2.ID.make("myron"), title: "retired" })
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })

      const admitted = yield* sessions.prompt({ sessionID: filed.id, prompt: { text: "anything" } })

      expect(admitted.sessionID).toBe(filed.id)
      const restored = yield* sessions.get(filed.id)
      expect(restored.time.archived).toBeUndefined()
      expect(restored.agent).toBe(AgentV2.ID.make("build"))
    }),
  )

  it.effect("CONTROL — a LIVE session takes the same prompt in place", () =>
    Effect.gen(function* () {
      // Without this the file would pass on a kernel that sent every prompt to some other chat, which
      // is the failure mode a one-sided resolution test cannot see.
      const sessions = yield* SessionV2.Service
      yield* hire("xenia")
      const live = yield* sessions.create({ location, agent: AgentV2.ID.make("xenia"), title: "working" })
      const admitted = yield* sessions.prompt({ sessionID: live.id, prompt: { text: "write hello.c here" } })
      expect(admitted.sessionID).toBe(live.id)
    }),
  )

  it.effect("CONTROL — Nova resolves through itself, and Nova is never in the config store", () =>
    Effect.gen(function* () {
      // The one colleague whose existence is NOT a config row: the governing agent is defined in code
      // and never seeded. Keying on the store alone would send Nova's filed chats down the restore
      // path and leave its real chat unused.
      const sessions = yield* SessionV2.Service
      expect((yield* (yield* AgentConfigStore.Service).agents())[AgentV2.NOVA_ID]).toBeUndefined()
      const filed = yield* sessions.create({ location, agent: AgentV2.NOVA_ID, title: "filed" })
      yield* sessions.setArchived({ sessionID: filed.id, time: Date.now() })
      const successor = yield* sessions.create({ location, agent: AgentV2.NOVA_ID, title: "current" })

      const admitted = yield* sessions.prompt({ sessionID: filed.id, prompt: { text: "status?" } })

      expect(admitted.sessionID).toBe(successor.id)
    }),
  )
})
