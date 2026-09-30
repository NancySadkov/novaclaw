import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { AbsolutePath } from "@novaclaw/core/schema"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { createSessionRecord } from "@novaclaw/core/session"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable, TodoTable } from "@novaclaw/core/session/sql"
import { moveArchivedToHistory } from "@novaclaw/core/session/rekey"
import { EventSequenceTable, EventTable } from "@novaclaw/core/event/sql"
import { testEffect } from "./lib/effect"

/**
 * ONE CHAT PER COLLEAGUE — enforced at `createSessionRecord`, the one seam every creator reaches.
 *
 * 🔴 Owner, 2026-08-23: *"every agent has a single chat. If the user wants a new chat, they either
 * clear chat with an existing agent or hire a new agent. That also applies to Nova."* The reason is
 * identity, not storage — a colleague with two conversations is two personalities wearing one name.
 *
 * **And for Nova it is authority, not just personality:** *"if there are more than one chain of
 * thoughts, then there are two Novas and a conflict of authority. They may do war on each other."*
 * The governing agent is the instance's floor, and a floor that can disagree with itself is not one.
 * `governing does not get an exemption` below is the test that says so — it is the carve-out someone
 * will eventually be tempted to add.
 *
 * Before this the rule was a convention: nothing rejected a second root session, the New Agent bar's
 * reuse probe only reopened an *empty* chat, and `chatFor` silently returned the most recently
 * touched. The loser of that pick had **no door** — the roster row is the only way into a
 * colleague's chat — while its tokens still rolled up into the colleague's totals.
 */

/**
 * ⚠️ Driven through `createSessionRecord` with its four explicit deps, NOT through `SessionV2.Service`.
 * That is not a shortcut — the module comment says this seam exists so `spawn` can reuse create
 * "WITHOUT depending on `SessionV2.node`, which would close the runner cycle
 * `SessionV2 -> LocationServiceMap -> location services -> spawn -> SessionV2`". Binding the full
 * service here fails on exactly that (`Unbound layer node: SessionExecution`), and the seam is where
 * the invariant actually lives, so this is the faithful target as well as the reachable one.
 */
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, ProjectV2.node, SessionStore.node]),
  ),
)

const deps = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    db,
    events: yield* EventV2.Service,
    projects: yield* ProjectV2.Service,
    store: yield* SessionStore.Service,
  }
})

const here = () => AbsolutePath.make(process.cwd())

/** A pre-existing chat, written straight to the row so the test does not depend on create's own rule. */
const seedChat = (
  db: Database.Interface["db"],
  row: { id: string; agent?: string; parent?: string; archived?: number; type?: "interactive" | "goal-oriented" },
) =>
  db
    .insert(SessionTable)
    .values([
      {
        id: SessionSchema.ID.make(row.id),
        slug: row.id,
        directory: process.cwd(),
        title: `${row.agent ?? "nobody"}'s chat`,
        version: "test",
        agent: row.agent,
        type: row.type,
        parent_id: row.parent ? SessionSchema.ID.make(row.parent) : undefined,
        time_archived: row.archived,
        time_created: 1,
        time_updated: 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)

const rootsFor = (db: Database.Interface["db"], agent: string) =>
  db
    .select()
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.filter((r) => r.agent === agent && !r.parent_id && r.time_archived === null)),
    )

describe("one chat per colleague", () => {
  it.effect("archived identity moves preserve references and arbitrary user content without creating a row", () =>
    Effect.gen(function* () {
      const d = yield* deps
      const oldID = SessionSchema.ID.make("ses_archive_move")
      const historyID = SessionSchema.ID.make("ses_archive_history")
      yield* seedChat(d.db, { id: oldID, agent: "archive_move", archived: 5 })
      yield* seedChat(d.db, { id: "ses_archive_child", parent: oldID })
      yield* d.db
        .insert(TodoTable)
        .values({
          session_id: oldID,
          content: "Keep this task",
          status: "pending",
          priority: "medium",
          position: 0,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const content = { sessionID: oldID, info: { id: oldID }, text: `Keep ${oldID} verbatim` }
      yield* d.db.insert(EventSequenceTable).values({ aggregate_id: oldID, seq: 1 }).run().pipe(Effect.orDie)
      yield* d.db
        .insert(EventTable)
        .values({
          id: EventV2.ID.create(),
          aggregate_id: oldID,
          seq: 1,
          type: "session.created.2",
          data: { sessionID: oldID, info: { id: oldID, metadata: content }, openingPrompt: content },
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* moveArchivedToHistory(d.db, oldID, historyID)).toBe(true)
      const rows = yield* d.db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === oldID)).toBeUndefined()
      expect(rows.find((row) => row.id === "ses_archive_child")?.parent_id).toBe(historyID)
      const todo = yield* d.db.select().from(TodoTable).get().pipe(Effect.orDie)
      expect(todo?.session_id).toBe(historyID)
      expect(todo?.content).toBe("Keep this task")
      const event = yield* d.db.select().from(EventTable).get().pipe(Effect.orDie)
      expect(event?.aggregate_id).toBe(historyID)
      expect(event?.data).toEqual({
        sessionID: historyID,
        info: { id: historyID, metadata: content },
        openingPrompt: content,
      })
    }),
  )

  it.effect("a live session cannot be moved through the archived-history seam", () =>
    Effect.gen(function* () {
      const d = yield* deps
      const liveID = SessionSchema.ID.make("ses_live_move")
      yield* seedChat(d.db, { id: liveID, agent: "live_move" })
      expect(yield* moveArchivedToHistory(d.db, liveID, SessionSchema.ID.make("ses_live_history"))).toBe(false)
      const rows = yield* d.db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(rows.map((row) => row.id)).toEqual([liveID])
    }),
  )

  it.effect("a second create for the same colleague returns the chat it already has", () =>
    Effect.gen(function* () {
      const d = yield* deps
      yield* seedChat(d.db, { id: "ses_theron", agent: "theron" })

      const created = yield* createSessionRecord(d, { agent: "theron", location: { directory: here() } } as never)

      // The SAME chat, not a sibling — an answer, not an error (the product rule is "you already
      // have that conversation").
      expect(String(created.id)).toBe("ses_theron")
      // ⚠️ The seeded row carries NO type, so this also pins the REPAIR: an absent constructor value
      // is filled in rather than left NULL. It reads `interactive` since the 2026-09-15 ruling that
      // made the kernel agree with the Mind tab's own default; see `colleagueType` in `session.ts`.
      expect(created.type).toBe("interactive")
      const roots_theron = yield* rootsFor(d.db, "theron")
      expect(roots_theron.length).toBe(1)
    }),
  )

  it.effect("a new colleague is born interactive, and an explicit unattended choice is what stands out", () =>
    Effect.gen(function* () {
      const d = yield* deps
      const byDefault = yield* createSessionRecord(d, {
        agent: "eris",
        location: { directory: here() },
      } as never)
      const autonomous = yield* createSessionRecord(d, {
        agent: "selene",
        type: "goal-oriented",
        location: { directory: here() },
      } as never)

      // Owner ruling 2026-09-15: Interactive is the default, and Unattended is the opt-in — which is
      // the only arrangement in which the composer's `· Goal` marker means anything. It is also what
      // the Mind tab's switch and the composer's own `?? "interactive"` already assumed.
      expect(byDefault.type).toBe("interactive")
      expect(autonomous.type).toBe("goal-oriented")
    }),
  )

  it.effect("governing does not get an exemption — two Novas would be two authorities", () =>
    Effect.gen(function* () {
      const d = yield* deps
      yield* seedChat(d.db, { id: "ses_nova", agent: "nova" })

      const created = yield* createSessionRecord(d, { agent: "nova", location: { directory: here() } } as never)

      expect(String(created.id)).toBe("ses_nova")
      const roots_nova = yield* rootsFor(d.db, "nova")
      expect(roots_nova.length).toBe(1)
    }),
  )

  it.effect("an ARCHIVED chat does not block its successor — that is what Clear chat does", () =>
    Effect.gen(function* () {
      const d = yield* deps
      // "Clear chat" archives rather than deletes. If an archived chat blocked creation, clearing
      // would leave the colleague permanently unable to start again.
      yield* seedChat(d.db, { id: "ses_old", agent: "spectre", archived: 5 })

      const created = yield* createSessionRecord(d, { agent: "spectre", location: { directory: here() } } as never)

      expect(String(created.id)).not.toBe("ses_old")
      const roots_spectre = yield* rootsFor(d.db, "spectre")
      expect(roots_spectre.length).toBe(1)
    }),
  )

  it.effect("a returning name does not open into its predecessor's chat", () =>
    Effect.gen(function* () {
      const d = yield* deps
      /**
       * 🔴 The hazard the canonical id CREATES, pinned here (2026-08-28). A colleague's chat now
       * carries the colleague's id, and retiring one archives the chat rather than deleting it — so
       * the archived row sits on the exact id the next holder of that name would be handed. Without
       * the yield-the-seat branch, hiring a new colleague on a returned name opens straight into the retired one's
       * transcript: months of somebody else's conversation, presented as their own, which is the
       * defect `AgentRetire.everything` exists to prevent.
       *
       * ⚠️ Distinct from the test above, which archives a chat under an unrelated id and so never
       * touches the canonical seat.
       *
       * A/B: drop `claimed === undefined` from the id choice in `createSessionRecord` and this fails
       * with `created.id === "ses_wraith"` — the archived chat handed back as if it were new.
       */
      yield* seedChat(d.db, { id: "ses_wraith", agent: "wraith", archived: 5 })

      const created = yield* createSessionRecord(d, { agent: "wraith", location: { directory: here() } } as never)

      // The archived transcript is moved aside; the live component gets the agent's canonical id
      // back. A random successor would leave the ECS identity split and make roster routing depend
      // on a compatibility scan.
      expect(String(created.id)).toBe("ses_wraith")
      expect(created.time.archived).toBeUndefined()
      const roots = yield* rootsFor(d.db, "wraith")
      expect(roots.length).toBe(1)
      const history = yield* d.db
        .select({ id: SessionTable.id, archived: SessionTable.time_archived })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      expect(history.some((row) => row.id !== "ses_wraith" && row.archived === 5)).toBe(true)
    }),
  )

  it.effect("a colleague's chat carries the COLLEAGUE's id", () =>
    Effect.gen(function* () {
      const d = yield* deps
      // The ECS lens made concrete: the chat is a component of the colleague, so it is reached
      // through the colleague rather than holding an identity of its own.
      const created = yield* createSessionRecord(d, { agent: "vesper", location: { directory: here() } } as never)

      expect(String(created.id)).toBe("ses_vesper")
    }),
  )

  it.effect("retired internal roles can never be colleagues", () =>
    Effect.gen(function* () {
      const d = yield* deps
      for (const id of AgentV2.RETIRED_ROLE_IDS) {
        expect(AgentV2.isColleague({ id, mode: "primary", hidden: false })).toBe(false)
        const result = yield* createSessionRecord(d, { agent: id, location: { directory: here() } } as never).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
    }),
  )

  it.effect("a CHILD needs no agent of its own — it hangs off one that has an owner", () =>
    Effect.gen(function* () {
      const d = yield* deps
      // The other half of the rule, or the guard above would be "no sub-sessions" wearing a costume.
      yield* seedChat(d.db, { id: "ses_officer2", agent: "vela" })
      const child = yield* createSessionRecord(d, {
        parentID: "ses_officer2",
        location: { directory: here() },
      } as never)
      expect(String(child.parentID)).toBe("ses_officer2")
    }),
  )

  it.effect("a SUB-AGENT is not collapsed into its officer's chat", () =>
    Effect.gen(function* () {
      const d = yield* deps
      // 🔴 A sub-agent inherits its officer's id. Without the `parentID === undefined` clause every
      // spawned worker would return the officer's chat and a fleet of six would be one session.
      yield* seedChat(d.db, { id: "ses_officer", agent: "theron" })

      const child = yield* createSessionRecord(d, {
        agent: "theron",
        parentID: SessionSchema.ID.make("ses_officer"),
        location: { directory: here() },
      } as never)

      expect(String(child.id)).not.toBe("ses_officer")
      expect(String(child.parentID)).toBe("ses_officer")
    }),
  )

  it.effect("a RETIRED id is under the one-chat rule too - the exemption had no referent left", () =>
    Effect.gen(function* () {
      const d = yield* deps
      // THIS TEST INVERTED, and the inversion is the finding. It used to read "a POSTURE is not a
      // person, so `build` chats are never collapsed" and assert TWO live `build` roots, on the
      // strength of a measured regression: scanning the owner's own stores on 2026-08-23 found
      // `build` x 54 and `nova` x 2 live root chats, and a guard keyed on `agent !== undefined` would
      // have merged all 54 into one conversation. That reasoning was correct, and the fix it drove -
      // key the guard on "is this a COLLEAGUE" - was correct.
      //
      // What it left behind was the mirror-image defect: an EXEMPTION rather than a distinction. The
      // `||` in `guardOneChat` then read that a posture is exempt from the rule, and the DB index
      // said the same thing by listing `build`/`plan` in its WHERE clause. So 55-98 live posture roots
      // accumulated on the owner's own instances - measured again 2026-08-24 - which is the very
      // collapse this test was written to prevent, arriving by the other door.
      //
      // The distinction and the exemption are not the same thing, and only the first survives a
      // retirement: a posture is still not a COLLEAGUE (six other readers in `session.ts` still ask
      // exactly that, for pre-retirement rows), but nothing grants it a chat of its own any more.
      // One live root, same as everyone.
      yield* seedChat(d.db, { id: "ses_build_1", agent: "build" })

      const refused = yield* Effect.exit(
        createSessionRecord(d, { agent: "build", location: { directory: here() } } as never),
      )
      expect(Exit.isFailure(refused), "a second live root was minted for a retired id").toBe(true)
      // ...and the first one is still there, untouched. The rule is one-per-agent, not none.
      expect((yield* rootsFor(d.db, "build")).length).toBe(1)
      // The genuine distinction still holds where it always did: a COLLEAGUE is one-per-agent too.
      //
      // ⚠️ And the control asserts ONE ROOT, not a REFUSAL, because the two arrive by different
      // doors and conflating them would have been a test that passes for the wrong reason. A
      // colleague's second create is IDEMPOTENT - `createSessionRecord` mints the canonical
      // `ses_<agent>` seat and the insert is `onConflictDoNothing`, so it returns the existing chat
      // rather than erroring. The posture case above has no canonical seat to land on (the seeded row
      // is `ses_build_1`), so the same rule has to stop it some other way, and the way it stops it is
      // `guardOneChat`. Same invariant, two mechanisms - which is why only the count is asserted here.
      yield* seedChat(d.db, { id: "ses_theron", agent: "theron" })
      const again = yield* createSessionRecord(d, { agent: "theron", location: { directory: here() } } as never)
      expect(String(again.id)).toBe("ses_theron")
      expect((yield* rootsFor(d.db, "theron")).length).toBe(1)
    }),
  )

  /**
   * 🔴 **REWRITTEN 2026-08-28 (NC-SEC-020). Both tests here simulated a fork by creating an anonymous
   * ROOT, and fork stopped producing that shape.**
   *
   * A fork is a CHILD of the chat it branches and carries that chat's owner (`session.ts`, fork). The
   * old pair asserted the opposite — *"Fork makes a fresh ROOT"*, *"fork drops the identity"* — and
   * one justified itself by saying the exemption *"passes `branchOf`"*. `branchOf` appears nowhere in
   * the tree but that sentence. What the bodies actually pinned was the `agent === undefined` hole,
   * which the second one's own comment called one that *"cannot be found and removed"*. It was found
   * by removing it.
   *
   * What still needs protecting is the real invariant: branching Theron's chat must not produce a
   * SECOND root for Theron. That is structural now — a child is not a root — and this says so.
   */
  it.effect("a fork branches a colleague's chat WITHOUT becoming a second chat for them", () =>
    Effect.gen(function* () {
      const d = yield* deps
      yield* seedChat(d.db, { id: "ses_theron", agent: "theron" })

      const branch = yield* createSessionRecord(d, {
        title: "fork of Theron's chat",
        parentID: "ses_theron",
        agent: "theron",
        location: { directory: here() },
      } as never)

      expect(String(branch.id)).not.toBe("ses_theron")
      expect(String(branch.parentID)).toBe("ses_theron")
      // The colleague still has exactly one ROOT, which is what the invariant is about. The branch
      // carries her identity and is reached through the chat it came from, not through the roster.
      expect((yield* rootsFor(d.db, "theron")).length).toBe(1)
    }),
  )

  it.effect("🔴 an anonymous ROOT is refused outright — there is no chat belonging to nobody", () =>
    Effect.gen(function* () {
      const d = yield* deps
      /**
       * The hole the two old tests pinned. `undefined` meant two different things: on a CHILD it
       * means *inherit from the parent*, which is legitimate; on a ROOT it meant nothing at all, so
       * every turn re-derived an owner from whatever the current default officer happened to be — a
       * chat whose identity, and therefore whose private memory cabinet, changed under it.
       */
      const refused = yield* createSessionRecord(d, {
        title: "a chat belonging to nobody",
        location: { directory: here() },
      } as never).pipe(Effect.flip)

      expect(refused._tag).toBe("Session.OwnerRequiredError")
    }),
  )
})
