import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

/**
 * ONE CHAT PER COLLEAGUE — THROUGH THE *OTHER* DOOR.
 *
 * 🔴 `createSessionRecord` enforces the invariant for anyone CREATING a chat. `switchAgent` MOVES an
 * existing chat onto an agent, and it published its event unconditionally: point a second root at a
 * colleague who already has one and they own two. The roster can show only one, so the other becomes
 * unreachable while its tokens still roll up into that colleague's totals — the same failure the
 * create-side guard exists to stop, reached through a public endpoint that a command's `agent:`
 * frontmatter also reaches.
 */

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

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

describe("switching a chat onto a colleague", () => {
  it.effect(
    "🔴 REFUSES when that colleague already has a live chat",
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      // Wren's chat, and a second unattributed root that someone tries to hand to Wren as well.
      yield* session.create({ location, agent: AgentV2.ID.make("writer") })
      const other = yield* session.create({ location, agent: rootAgent, title: "somewhere else" })

      const refusal = yield* session.switchAgent({ sessionID: other.id, agent: "writer" }).pipe(Effect.flip)
      expect(String(refusal._tag)).toContain("OperationUnavailable")
      expect(String((refusal as { operation?: string }).operation)).toBe("switchAgent")
    }),
  )

  test("🔴 the COMMAND door goes through the SAME guard, not a bare publish", () => {
    // `V2Session.command` published `AgentSwitched` DIRECTLY, so a saved command declaring
    // `agent: writer` could point a second session at Wren while `switchAgent`, one function away,
    // refused exactly that. Two doors, one unguarded, is the shape this invariant keeps being broken
    // by — `createSessionRecord` and `switchAgent` were the first pair.
    //
    // ⚠️ STRUCTURAL, and the reason is worth stating. Driving the command path needs a saved
    // command visible to `CommandV2`, which reads through a location service this fixture does not
    // stand up; wiring it here would be fixture archaeology testing the command LOADER rather than
    // the guard. The RULE is already covered behaviourally by the four cases in this file, so what
    // is left to pin is the JOIN: that the command path calls it at all.
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "src", "session.ts"), "utf8")
    const command = source.slice(source.indexOf('command: Effect.fn("V2Session.command")'))
    const switchBlock = command.slice(0, command.indexOf("SessionEvent.AgentSwitched"))
    expect(switchBlock).toContain("guardOneChat(session, resolved.agent")
  })

  it.effect(
    '🔴 a root with NEITHER agent nor title names its folder, not "New session"',
    Effect.gen(function* () {
      // The last ghost shape: a row saying neither who it belongs to nor what it is for.
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: rootAgent })
      expect(created.title).toBe("New session in project")
    }),
  )

  it.effect(
    "⚠️ a row that names its AGENT is left alone — its title is the colleague's business",
    Effect.gen(function* () {
      // Already attributable, and the launcher and Contacts both pass a real title. Naming the
      // folder here would fight them for it.
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: AgentV2.ID.make("editor") })
      expect(created.title).toBe("New session")
    }),
  )

  it.effect(
    "…and ALLOWS it when that colleague has none",
    Effect.gen(function* () {
      // The control. Without it, a `switchAgent` that refused everything would pass the test above.
      const session = yield* SessionV2.Service
      const other = yield* session.create({ location, agent: rootAgent, title: "somewhere else" })
      const outcome = yield* session.switchAgent({ sessionID: other.id, agent: "editor" }).pipe(Effect.exit)
      expect(outcome._tag).toBe("Success")
    }),
  )

  it.effect(
    "a switch onto the agent it ALREADY runs as is a no-op, not a conflict",
    Effect.gen(function* () {
      // Otherwise re-issuing the same command fails the second time — the chat's own live root is
      // found and mistaken for somebody else's.
      const session = yield* SessionV2.Service
      const wren = yield* session.create({ location, agent: AgentV2.ID.make("writer") })
      const outcome = yield* session.switchAgent({ sessionID: wren.id, agent: "writer" }).pipe(Effect.exit)
      expect(outcome._tag).toBe("Success")
    }),
  )

  it.effect(
    "⚠️ a POSTURE is exempt — it is not a colleague and owns no chat",
    Effect.gen(function* () {
      // Keyed on `isColleague`, not on "has an agent": `build` is the mode most chats run as, and
      // treating it as an owner would collapse every one of them into a single conversation.
      const session = yield* SessionV2.Service
      yield* session.create({ location, agent: AgentV2.BUILD_ID })
      const other = yield* session.create({ location, agent: rootAgent, title: "another" })
      const outcome = yield* session
        .switchAgent({ sessionID: other.id, agent: String(AgentV2.BUILD_ID) })
        .pipe(Effect.exit)
      expect(outcome._tag).toBe("Success")
    }),
  )
})
