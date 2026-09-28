import { and, eq, gte, isNull, like, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionInput } from "./input"
import { resolveSessionMode } from "./mode"
import { SessionMessage } from "./message"
import { NOTICE_PREFIX } from "./notice"
import type { SessionSchema } from "./schema"
import { SessionInputTable, SessionTable } from "./sql"

export * as ColleagueStall from "./colleague-stall"

/**
 * AN ASK NOBODY ANSWERED — found from what is already stored, and told once.
 *
 * 🔴 A REFUSED hand-off is reported to the sender; an ACCEPTED and never-answered one is silent. On a
 * real project that is the stall mode that matters: the asker sits on a promise it made to the user,
 * waiting for a reply that is not coming, and nothing anywhere says so.
 *
 * ⚠️ **Detection needs no new state.** An ask from A to B is an input row in B's session whose origin
 * names A; it is ANSWERED when a later row in A's session names B. Both already exist.
 *
 * ⚠️ **Nor does telling it once.** The tick fires every 30 s, so a notice needs a memory of having
 * been sent — and the notice IS that memory, if its id is derived from the ask rather than random.
 * The primary key then refuses the second insert, which is idempotency the database enforces instead
 * of a table we would have to keep in step.
 */

/** One peer message that landed: which chat received it, who sent it, when. */
export interface Landed {
  /** The session the message was delivered INTO. */
  readonly sessionID: string
  /** The agent that sent it. */
  readonly from: string
  readonly at: number
  /**
   * This copy INFORMED the reader; it asked them nothing.
   *
   * 🔴 A conference reply is copied to every bystander, and those copies were byte-identical to an
   * ask. So each bystander who correctly said nothing looked like a colleague ignoring a question,
   * and a ≥3-party room minted a false stall PER BYSTANDER on every reply — whose "ask again" then
   * woke the room, which is the amplification the announce discipline exists to remove.
   */
  readonly announce?: boolean | undefined
}

export interface Stalled {
  readonly asker: string
  readonly colleague: string
  readonly askedAt: number
}

/**
 * How long before an unanswered ask is worth mentioning.
 *
 * 🔴 **Conservative BY CONSTRUCTION, not fitted** — and that is a resolution rather than a guess.
 * `threshold-that-fires-on-normal` forbids arming an unmeasured threshold; principle 12(a) forbids
 * shipping it off by default (*work by default* — a setting is an override, not a doorway). The two
 * are reconciled by asymmetric risk: a stall notice that arrives LATE is mildly useless, while one
 * that fires on a healthy exchange teaches everyone to ignore the notice, and then the real stall is
 * invisible too.
 *
 * Thirty minutes is far above any plausible healthy reply, because an ASK still wakes its recipient —
 * the wake discipline dampens replies, not asks — so a healthy answer is one turn away rather than
 * one dormant chat away. ⏳ Tighten it when a measured distribution exists; this number is a ceiling
 * chosen to be un-hittable by a working exchange, not an estimate of one.
 */
export const AFTER_MS = 30 * 60_000

/**
 * The prefix every stall notice's id carries, and the predicate that recognises one — defined in the
 * leaf `./notice` so the browser transcript can fold a notice without importing this module's
 * database tree. Re-exported here so existing `ColleagueStall.<name>` callers are unchanged.
 */
export { NOTICE_PREFIX, isNotice } from "./notice"

/**
 * The id a notice for this PAIR must have — deterministic, so the second attempt collides.
 *
 * 🔴 Keyed on the COLLEAGUE, not on the ask. With `askedAt` in the id, the anchor moving (the oldest
 * unanswered ask aging out of the 24h lookback, or being answered) minted a NEW id and re-noticed the
 * same pair — the drip the owner saw at ~23h ages (owner, 2026-09-26).
 *
 * ⚠️ **IT IS ALSO THE PERMANENT MEMORY OF HAVING TOLD THEM** (owner, 2026-09-26: *"once such pending
 * notification is sent to the session, it will no longer be sent again"*). Nothing retires a minted
 * notice any more: this sweep has no delete of its own, so a pair told once is told once for the life
 * of the instance. The ONE deletion is {@link clearPending}, and it belongs to the user's Clear chat.
 */
export const noticeID = (input: Stalled): string => `${NOTICE_PREFIX}${input.asker}_${input.colleague}`

/**
 * Drop the notices this chat has not read yet, because the chat is being CLEARED.
 *
 * 🔴 **CLEAR CHAT IS THE ONE EVENT THAT MAKES A PENDING NOTICE OBSOLETE** (owner, 2026-09-26: *"Daedalus
 * still gets spammed with 'the message to nova you sent 1437 minutes ago is still unanswered' even
 * after a Clear chat was used — please ensure that clearing the session also clears all such obsolete
 * pending notification"*).
 *
 * The notice is a queued input, so a cleared chat would otherwise carry it into the archive as a
 * message nobody can ever read, and — before the generation rule in {@link stalled} — the sweep would
 * mint a fresh copy into the replacement chat on the very next tick, about a promise made in the
 * conversation that had just been thrown away.
 *
 * ⚠️ **PENDING ONLY, and that is the whole of "once sent, it will not be sent again".** A notice the
 * agent has already read (`promoted_seq` set) is the asker's history and the pair's permanent memory:
 * deleting it would free the id and let the same fact be told again, which is the drip the owner ruled
 * out. A notice still sitting in the queue was never read, so clearing it costs the asker nothing and
 * leaves the pair free to be told once about a genuinely new ask.
 *
 * ⚠️ **CLEAR CHAT IS NOT THIS DOOR, and the difference matters.** `clearOfficerChat` calls
 * `session.remove` on every root it takes, and an ARCHIVE keeps its rows. So on the product's own
 * gesture the notice dies with the chat by the schema's cascade (`PRAGMA foreign_keys = ON`), and what
 * actually went wrong for the owner was the sweep minting a FRESH copy into the successor 30 s later —
 * which is what the generation rule in {@link stalled} prevents. This function covers the other door,
 * where rows survive and a queued input would otherwise sit in an archive unreadable for ever.
 */
export const clearPending = (db: Database.Interface["db"], sessionID: SessionSchema.ID): Effect.Effect<number> =>
  Effect.gen(function* () {
    // Selected before deleted rather than reading the driver's affected-row count: the count is the
    // only thing a caller has to go on here, and it is also what a test asserts, so it must not depend
    // on which shape this driver happens to return.
    const doomed = yield* db
      .select({ id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(
        and(
          eq(SessionInputTable.session_id, sessionID),
          isNull(SessionInputTable.promoted_seq),
          like(SessionInputTable.id, `${NOTICE_PREFIX}%`),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of doomed)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, row.id)).run().pipe(Effect.orDie)
    return doomed.length
  })

/**
 * Which asks have gone unanswered for longer than `after`.
 *
 * @param landed every peer message in the instance, newest or oldest first — order does not matter.
 * @param agentOf which agent owns a session, so a delivery's recipient can be named.
 * @param chatOf which session belongs to an agent, so the answer can be looked for in the right one.
 */
export const stalled = (input: {
  readonly landed: ReadonlyArray<Landed>
  readonly agentOf: Readonly<Record<string, string>>
  readonly chatOf: Readonly<Record<string, string>>
  /**
   * When the asker's CURRENT chat was created, by agent id.
   *
   * 🔴 REQUIRED, and required precisely so no call site can leave it out: an ask made before the
   * asker's present chat existed cannot still be outstanding in it (see the rule in the loop). An
   * optional field here would be optional in exactly the one place that matters, which is how this
   * shipped the first time.
   */
  readonly chatBornAt: Readonly<Record<string, number>>
  readonly now: number
  readonly after?: number
}): Stalled[] => {
  const after = input.after ?? AFTER_MS
  /**
   * ONE NOTICE PER COLLEAGUE, not one per historical message.
   *
   * 🔴 Owner report 2026-09-26: after a relaunch Daedalus was DELUGED with stall notices. The sweep
   * looks back 24 h, and a chatty pair leaves dozens of unanswered asks in that window — measured on
   * the owner's instance, **33 notices landed in `ses_daedalus` in ONE tick**, one for every
   * unanswered ask going back 22 hours, several of them identical to the eye. Telling an asker once
   * per outstanding ASK is telling it the same fact N times. The unit is the PAIR: a colleague either
   * answered you or it did not, and the oldest unanswered ask is the one that measures the wait.
   *
   * ⚠️ Keyed on the oldest ask, so the notice is STABLE while that ask stays unanswered (same derived
   * id -> the primary key refuses a re-send). If that ask is later answered but others remain, the
   * anchor moves to the next-oldest and a fresh notice is legitimate — that is a new stall, not a
   * repeat.
   */
  const out = new Map<string, Stalled>()
  // ⚠️ INDEXED ONCE. Both lookups below are "what else is in the ASKER's chat", and doing them with a
  // `filter`/`some` over every landed message made this O(n²) in the number of peer messages on the
  // instance — inside a sweep that runs every 30 s. Grouping by session first makes each lookup touch
  // only that chat's own rows, which is the set the question was always about.
  const bySession = new Map<string, Landed[]>()
  for (const row of input.landed) {
    const list = bySession.get(row.sessionID)
    if (list === undefined) bySession.set(row.sessionID, [row])
    else list.push(row)
  }
  for (const list of bySession.values()) list.sort((left, right) => left.at - right.at)
  for (const ask of input.landed) {
    // 🔴 AN ANNOUNCE IS NOT AN ASK. Nobody is waiting on a bystander, so silence from one is the
    // room working, not a stall — and reporting it would teach everyone to ignore the notice, which
    // `AFTER_MS`'s own comment calls the fatal outcome.
    if (ask.announce === true) continue
    const colleague = input.agentOf[ask.sessionID]
    // A delivery into a chat with no agent cannot be attributed, and an agent asking itself is not a
    // thing `deliver` permits — either way there is nobody to tell.
    if (colleague === undefined || colleague === ask.from) continue
    if (input.now - ask.at <= after) continue
    const askerChat = input.chatOf[ask.from]
    if (askerChat === undefined) continue
    /**
     * 🔴 **AN ASK FROM A PREVIOUS GENERATION OF THE ASKER'S CHAT CANNOT BE OUTSTANDING IN THIS ONE.**
     *
     * Owner report, 2026-09-26: Daedalus was told *"The message to nova you sent 1437 minutes ago is
     * still unanswered"* **in a chat created minutes earlier**. Read from the instance: the fresh
     * `ses_daedalus` was created at 19:40, the notice was written into it at 19:40, and the ask it
     * names was made at 20:13 the previous day — in the conversation that Clear chat had just
     * archived. The promise, its context and the wait all belonged to a transcript that no longer
     * exists, and the 24 h lookback could not tell the difference, so every clear handed the asker a
     * fresh notice about a dead conversation.
     *
     * ⚠️ The fix is the CHAT's own birth, not a shorter window: shortening the lookback would lose
     * real stalls (a 23 h wait is still a stall worth one line) and would not survive a second clear.
     * A promise can only be outstanding in a conversation that was open when it was made.
     */
    if (ask.at < (input.chatBornAt[ask.from] ?? 0)) continue
    // 🔴 AN ANSWER IS NOT AN ASK. Every peer message looks alike here, so without this an answer
    // becomes a new unanswered ask and every completed exchange reports a stall — the reply itself
    // read as the thing nobody replied to.
    //
    // The test mirrors `ColleagueNote.turnFor` rather than inventing a second rule: this is an answer
    // when the last peer message the sender received BEFORE writing came from the colleague it is now
    // writing to. Two rules for one distinction is how they drift apart.
    const inAskersChat = bySession.get(askerChat) ?? []
    // Sorted ascending, so the last row before `ask.at` is the newest one that precedes it.
    let priorInSendersChat: Landed | undefined
    for (const row of inAskersChat) {
      if (row.at >= ask.at) break
      priorInSendersChat = row
    }
    if (priorInSendersChat?.from === colleague) continue
    // ⚠️ ANY later message from that colleague counts as an answer, not only one that parses as one.
    // A reply the asker can read is the outcome that matters, and a stricter test would report a
    // colleague that answered in its own words as silent — the worst kind of false alarm, because
    // the asker can see the answer sitting in its chat.
    const answered = inAskersChat.some((reply) => reply.from === colleague && reply.at > ask.at)
    if (answered) continue
    const key = `${ask.from}\u0000${colleague}`
    const existing = out.get(key)
    if (existing === undefined || ask.at < existing.askedAt)
      out.set(key, { asker: ask.from, colleague, askedAt: ask.at })
  }
  return [...out.values()]
}

/** What the asker is told, in its own chat. `colleague` is the agent id the tool layer uses. */
export const notice = (input: Stalled & { readonly minutes: number }): string =>
  `The message to ${input.colleague} you sent ${input.minutes} minutes ago is still unanswered. ` +
  `If you promised this answer to someone, report back, then ask again, do it yourself, or tell ` +
  `your superior it is outstanding.`

/**
 * How far back a sweep looks.
 *
 * ⚠️ Bounded on purpose: this runs every 30 s, and a scan of every input row an instance has ever
 * admitted would be a guard that becomes the problem it guards against. A day is far past the point
 * where a notice is still useful — nobody needs telling on Thursday that Tuesday's ask went
 * unanswered, and the asker's own chat has moved on.
 */
export const LOOKBACK_MS = 24 * 60 * 60_000

/**
 * Find stalled asks and tell each asker, once, in its own chat.
 *
 * ⚠️ **Lands DORMANT.** It obeys the wake discipline: a stall notice that summons a worker to read it
 * has traded one waste for another. It is read when that chat next runs.
 *
 * ⚠️ **Never throws into the caller.** This rides the schedule tick rather than a timer of its own
 * (a sweeper for one notice is a subsystem to keep alive), so a failure here must not stop schedules
 * from firing.
 */
export const sweep = (db: Database.Interface["db"], events: EventV2.Interface, now: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const sessions = yield* db
      .select({ id: SessionTable.id, agent: SessionTable.agent, born: SessionTable.time_created })
      .from(SessionTable)
      .where(isNull(SessionTable.time_archived))
      .all()
      .pipe(Effect.orDie)
    const agentOf: Record<string, string> = {}
    const chatOf: Record<string, string> = {}
    const chatBornAt: Record<string, number> = {}
    for (const row of sessions) {
      if (!row.agent || (yield* resolveSessionMode(db, row.id)) !== "agent") continue
      agentOf[row.id] = row.agent
      // One chat per agent, so the first is the only. ⚠️ The birth time is taken under the SAME
      // `??=` as the id it belongs to, so the two can never name different sessions — the rule in
      // `stalled` compares an ask against the birth of the very chat the notice would go to.
      chatOf[row.agent] ??= row.id
      chatBornAt[row.agent] ??= row.born
    }

    // 🔴 THE DATABASE DOES THE FILTERING, and it is not a micro-optimisation: this runs every 30 s.
    // Selecting whole `prompt` blobs for every input row in 24 h meant decoding every user message,
    // every attachment list and every steer on an instance — to keep the handful that carry a peer
    // origin. The cost grew with HISTORY rather than with the thing being looked for, which is the
    // shape of a guard that eventually becomes the problem it guards against.
    //
    // ⚠️ `json_extract` reads the SAME fields the loop below used to read off the decoded object, so
    // there is one definition of "a peer message" and it did not move — it just runs where the rows
    // are. `announce` comes back as SQLite's 0/1, hence the `=== 1`.
    const rows = yield* db
      .select({
        session: SessionInputTable.session_id,
        at: SessionInputTable.time_created,
        from: sql<string | null>`json_extract(${SessionInputTable.prompt}, '$.origin.label')`,
        announce: sql<number | null>`json_extract(${SessionInputTable.prompt}, '$.origin.announce')`,
      })
      .from(SessionInputTable)
      .where(
        and(
          gte(SessionInputTable.time_created, now - LOOKBACK_MS),
          sql`json_extract(${SessionInputTable.prompt}, '$.origin.via') = 'agent'`,
          sql`json_extract(${SessionInputTable.prompt}, '$.origin.relation') = 'peer'`,
        ),
      )
      .all()
      .pipe(Effect.orDie)

    const landed: Landed[] = []
    for (const row of rows) {
      if (typeof row.from !== "string" || row.from === "") continue
      landed.push({
        sessionID: String(row.session),
        from: row.from,
        at: Number(row.at),
        announce: row.announce === 1,
      })
    }

    let told = 0
    const stalls = stalled({ landed, agentOf, chatOf, chatBornAt, now })

    for (const stall of stalls) {
      const chat = chatOf[stall.asker]
      if (chat === undefined) continue
      const id = SessionMessage.ID.make(noticeID(stall))
      // 🔴 The id IS the memory of having told them — a second sweep derives the same one. Asking
      // first is only about the COUNT: `SessionInput.admit` is already idempotent (it finds the row
      // and returns it), so without this the sweep reports a fresh notice every 30 s for one that was
      // sent hours ago. The row cannot duplicate either way, which is what makes the check-then-act
      // safe against a concurrent tick: the worst case is two ticks both reporting one write.
      const already = yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (already !== undefined) continue
      const written = yield* SessionInput.automated(db, events, {
        id,
        sessionID: chat as SessionSchema.ID,
        prompt: {
          text: notice({ ...stall, minutes: Math.round((now - stall.askedAt) / 60_000) }),
          files: [],
          agents: [],
          // No peer origin: this is the instance reporting silence, not a colleague speaking. Giving
          // it one would put the notice on the next path and make it answerable.
          origin: undefined,
        },
        delivery: "queue",
      }).pipe(
        Effect.map((admitted) => admitted !== undefined),
        Effect.orElseSucceed(() => false),
      )
      if (written) told += 1
    }
    return told
  }).pipe(Effect.orElseSucceed(() => 0))
