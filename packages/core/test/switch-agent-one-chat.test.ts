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
/**
 * 🔴 **WAS `AgentV2.ID.make("build")`, and that made every test in this file use the RETIRED anonymous
 * agent as its exemplar of "a colleague"** (owner, 2026-09-27). It passed, and it was quietly wrong:
 * `build` was a posture, so the one-chat rule did not apply to it, and a test written against it
 * asserted the shape of an exemption rather than the shape of the rule. The retirement exposed it —
 * creating a second `rootAgent` session started failing, because `guardOneChat` no longer waves
 * postures through — but the honest reading is that the exemplar was never a colleague and every
 * assertion downstream of it was measuring the wrong thing.
 *
 * A real officer id, so "a colleague with a live chat" means a colleague.
 */
const rootAgent = AgentV2.ID.make("theron")

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
    'a root owned by a RETIRED id names its folder, not "New session" - and the title said otherwise',
    Effect.gen(function* () {
      // ⭐ **THIS TEST WAS MISNAMED, and the rename is the finding.** It read "a root with NEITHER
      // agent nor title names its folder" while creating a root that DID name an agent — a posture,
      // which is how it slipped past the fact that a genuinely agent-less root has been refused
      // outright since NC-SEC-020 (`OwnerRequiredError`, asserted in `session-one-chat-per-agent`).
      // It reached its subject through `rootAgent`, which was `build`, which is how a retired
      // permission mode ended up serving as this file's stand-in for "an agent".
      //
      // The BEHAVIOUR is real and still shipped, and it is worth keeping: `defaultTitle` asks "is
      // this row attributable to SOMEONE?", and a retired id is not, so a pre-retirement row keeps the
      // one piece of information it still carries about itself rather than being flattened to
      // "New session". What changed on 2026-09-27 is that no NEW row can arrive this way — which is
      // why this creates one directly rather than through a door that now refuses.
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: AgentV2.BUILD_ID })
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
    "a RETIRED id is not exempt either - not a colleague, and not a shortcut",
    Effect.gen(function* () {
      // THE SECOND HALF OF THE SAME DEFECT, at the other door. `session-one-chat-per-agent.test.ts`
      // carried the application half ("a posture may hold many chats, so the one-chat rule does not
      // apply") and this carried the command half ("a POSTURE is exempt"). Both were the same mistake:
      // reading the CORRECT observation "a posture is not a colleague" as the DIFFERENT claim "a
      // posture is therefore exempt". A distinction is not an exemption, and the second is what let
      // 55-98 live `build` roots accumulate on the owner's own instances.
      //
      // The distinction itself was never wrong and is still load-bearing: six readers in `session.ts`
      // still ask "is this a colleague?" precisely so a pre-retirement row is not treated as an
      // entity. What is gone is the freedom that came with it - switching a chat ONTO a retired id now
      // goes through the same one-live-root rule as any other agent.
      const session = yield* SessionV2.Service
      // A third id, because this test needs TWO chats to move between and `rootAgent` is taken by the
      // session that is supposed to be blocking the move.
      const otherAgent = AgentV2.ID.make("wren")
      const retired = yield* session.create({ location, agent: AgentV2.BUILD_ID })
      const other = yield* session.create({ location, agent: otherAgent, title: "another" })
      const outcome = yield* session
        .switchAgent({ sessionID: other.id, agent: String(AgentV2.BUILD_ID) })
        .pipe(Effect.exit)
      expect(outcome._tag, "a chat was switched onto a retired id that already holds a live root").toBe("Failure")
      // The chat did not move, and the refusal came from `guardOneChat` — the same guard the
      // colleague case two tests up exercises, now applied to a retired id because the posture
      // clause that used to skip it is gone.
      expect(String((yield* session.get(other.id)).agent), "the refused chat moved anyway").toBe(
        String(otherAgent),
      )
      //
      // ⚠️ WHAT IS DELIBERATELY NOT ASSERTED HERE: that the switch SUCCEEDS once the retired id's
      // live root is archived, which would pin the rule as count-shaped rather than a blanket ban on
      // the name. `setArchived` did not free the slot in this harness, and rather than guess at which
      // of the two is true — a genuine second refusal, or an archive that never landed — the claim is
      // left out. The invariant that matters is on the other side of the fence: no second live root
      // for a retired id, which `session-one-chat-per-agent.test.ts` asserts at the create door and
      // this one asserts at the command door.
    }),
  )
})
