import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentStatus } from "@novaclaw/core/agent-status"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentStatus.node])))

/** A chat row for `agent`, plus one message at `at`. */
const seed = (
  db: Database.Interface["db"],
  input: { id: string; agent: string; at: number; archived?: number; parent?: string },
) =>
  Effect.gen(function* () {
    yield* db
      .insert(SessionTable)
      .values({
        id: input.id as never,
        slug: input.id,
        version: "0.0.0",
        directory: "/w",
        agent: input.agent,
        // ⚠️ A sub-session must name its parent. Two ROOTS for one colleague violate
        // `session_agent_live_root_idx` — the one-chat-per-colleague rule, enforced in the database —
        // and the first version of this helper hit exactly that.
        ...(input.parent === undefined ? {} : { parent_id: input.parent }),
        title: "chat",
        time_created: input.at,
        time_updated: input.at,
        ...(input.archived === undefined ? {} : { time_archived: input.archived }),
      } as never)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: `msg_${input.id}_${input.at}` as never,
        session_id: input.id as never,
        type: "user" as never,
        seq: input.at,
        data: {} as never,
        time_created: input.at,
        time_updated: input.at,
      } as never)
      .run()
      .pipe(Effect.orDie)
  })

describe("AgentStatus", () => {
  it.effect("round-trips a colleague's line and replaces it on the next pass", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      yield* status.set({ agent: "theron", task: "reviewing the P2P handshake", observed: 1_000 })
      expect(yield* status.get("theron")).toEqual({
        agent: "theron",
        task: "reviewing the P2P handshake",
        observed: 1_000,
      })

      // The pass REPLACES rather than appends — one line per colleague is the whole contract.
      yield* status.set({ agent: "theron", task: "writing the migration", observed: 2_000 })
      expect((yield* status.get("theron"))?.task).toBe("writing the migration")
      expect(yield* status.all()).toHaveLength(1)
    }),
  )

  it.effect("a colleague with no line at all reads as undefined, not as an empty one", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      // Contacts must be able to tell "nothing to say" from "said nothing" — the first shows no
      // status line, the second would show a blank one where a sentence belongs.
      expect(yield* status.get("nobody")).toBeUndefined()
    }),
  )

  it.effect("🔴 activity is measured in MESSAGES, across a colleague's whole thread tree", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_theron", agent: "theron", at: 5_000 })
      // A sub-session carries the same agent, and work done there is still that colleague's work.
      yield* seed(db, { id: "ses_child", agent: "theron", at: 9_000, parent: "ses_theron" })
      yield* seed(db, { id: "ses_xenia", agent: "xenia", at: 3_000 })

      const candidates = yield* status.candidates()
      const theron = candidates.find((c) => c.agent === "theron")
      expect(theron?.latest).toBe(9_000)
      expect(candidates.find((c) => c.agent === "xenia")?.latest).toBe(3_000)
    }),
  )

  it.effect("🔴 an ARCHIVED chat is not activity", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_live", agent: "vera", at: 4_000 })
      yield* seed(db, { id: "ses_gone", agent: "vera", at: 8_000, archived: 8_500, parent: "ses_live" })

      /**
       * "Clear chat" archives rather than deletes, so an archived transcript is history the user has
       * explicitly set aside. Counting it would keep a colleague's status line pinned to work they
       * asked to put away — and would report them as busy for a conversation that no longer exists
       * anywhere they can see.
       */
      expect((yield* status.candidates()).find((c) => c.agent === "vera")?.latest).toBe(4_000)
    }),
  )

  it.effect("candidates carry the CURRENT line so the decision can compare the two", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_dana", agent: "dana", at: 7_000 })
      yield* status.set({ agent: "dana", task: "an older thing", observed: 6_000 })

      const dana = (yield* status.candidates()).find((c) => c.agent === "dana")
      expect(dana).toEqual({ agent: "dana", latest: 7_000, current: { observed: 6_000 } })
    }),
  )

  it.effect("🔴 the newest session is the one a line is derived from, sub-sessions included", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_ada", agent: "ada", at: 1_000 })
      yield* seed(db, { id: "ses_ada_child", agent: "ada", at: 6_000, parent: "ses_ada" })

      /**
       * Not the root chat. A delegating officer's newest work is in a sub-session, and reading the
       * root would describe them by whatever they were last asked DIRECTLY rather than by what they
       * are actually doing — the difference between "waiting for instructions" and "reviewing the
       * handshake" for the same colleague at the same moment.
       *
       * A/B: order ascending, or scope to the root, and this returns `ses_ada`.
       */
      expect(yield* status.newestSession("ada")).toBe("ses_ada_child")
    }),
  )

  it.effect("a colleague with no messages at all has no session to read", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      expect(yield* status.newestSession("ghost")).toBeUndefined()
    }),
  )

  it.effect("🔴 an archived transcript is never the one read", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_iris", agent: "iris", at: 2_000 })
      yield* seed(db, { id: "ses_iris_old", agent: "iris", at: 9_000, archived: 9_500, parent: "ses_iris" })
      // The newest MESSAGE is in the archived thread; the newest readable one is not.
      expect(yield* status.newestSession("iris")).toBe("ses_iris")
    }),
  )

  it.effect("🔴 a POSTURE is not a colleague and gets no status line", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      const { db } = yield* Database.Service
      yield* seed(db, { id: "ses_posture", agent: AgentV2.BUILD_ID, at: 2_000 })

      /**
       * `build` and `plan` say how a chat RUNS, not whose it is. Neither has a Contacts row, so a
       * status line for one is a line nothing can display — the same distinction the one-live-root
       * index makes, and the one `defaultTitle` needed when every root began naming an agent.
       *
       * A/B: drop the `NOT IN ('build','plan')` clause and this fails.
       */
      expect((yield* status.candidates()).find((c) => c.agent === AgentV2.BUILD_ID)).toBeUndefined()
    }),
  )
})
