import { and, eq, gte, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
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
 * The prefix every stall notice's id carries.
 *
 * 🔴 It is LOAD-BEARING TWICE. The id is already the memory of having told someone (a second sweep
 * derives the same one and the primary key refuses it), and it is also how the two hop walks
 * recognise a notice they must not read as a turn — see {@link isNotice}.
 */
export const NOTICE_PREFIX = "msg_stall_"

/** The id a notice for this ask MUST have — deterministic, so the second attempt collides. */
export const noticeID = (input: Stalled): string => `${NOTICE_PREFIX}${input.asker}_${input.colleague}_${input.askedAt}`

/**
 * Is this message an instance notice rather than somebody's turn?
 *
 * 🔴 **A notice must not RESET the bound it polices.** It is admitted with no origin — deliberately,
 * because it is the instance reporting silence and giving it a peer origin would make it answerable
 * and count it as a hop. But both hop walks read "user-role message with no agent origin" as A REAL
 * PERSON SPEAKING, which ends the chain and returns 0. So the notice that says *"ask again"* handed
 * the asker a fresh budget of `HOP_CAP` hops, every thirty minutes, for ever — an unbounded re-ask
 * loop invisible to the cap, the path AND the rate window, created by the very thing meant to report
 * the stall.
 *
 * SKIPPED, not counted: the walk steps over a notice and keeps going, so the chain behind it is
 * preserved exactly. A notice is nobody's turn — it neither advances a chain nor ends one.
 *
 * ⚠️ Keyed on the id rather than a new field on `Prompt` or a new `Origin` member. Both of those are
 * hand-listed subsets that go stale silently (`Prompt.fromUserMessage` enumerates its four fields;
 * `origin.ts` branches on `via === "agent"` and lets everything else fall through to the MESSENGER
 * renderer, so a third member would render as a chat message at fourteen sites). The id is already
 * durable, already deterministic and already load-bearing here. When a SECOND kind of instance notice
 * appears, promote this to an `Origin` member and audit those sites then.
 */
export const isNotice = (messageID: string | undefined): boolean =>
  typeof messageID === "string" && messageID.startsWith(NOTICE_PREFIX)

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
  readonly now: number
  readonly after?: number
}): Stalled[] => {
  const after = input.after ?? AFTER_MS
  const out: Stalled[] = []
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
    if (!answered) out.push({ asker: ask.from, colleague, askedAt: ask.at })
  }
  return out
}

/** What the asker is told, in its own chat. */
export const notice = (input: Stalled & { readonly minutes: number }): string =>
  `[${input.colleague} has not answered you. You asked ${input.minutes} minutes ago and nothing has ` +
  `come back. Nobody is waiting on you here — but if you promised this answer to someone, say where ` +
  `it stands rather than keep waiting: ask again, do it yourself, or tell the user it is outstanding.]`

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
 * ⚠️ **Never throws into the caller.** This rides the calendar tick rather than a timer of its own
 * (a sweeper for one notice is a subsystem to keep alive), so a failure here must not stop schedules
 * from firing.
 */
export const sweep = (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  now: number,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const sessions = yield* db
      .select({ id: SessionTable.id, agent: SessionTable.agent })
      .from(SessionTable)
      .where(isNull(SessionTable.time_archived))
      .all()
      .pipe(Effect.orDie)
    const agentOf: Record<string, string> = {}
    const chatOf: Record<string, string> = {}
    for (const row of sessions) {
      if (!row.agent) continue
      agentOf[row.id] = row.agent
      // One chat per agent, so the first is the only.
      chatOf[row.agent] ??= row.id
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
    for (const stall of stalled({ landed, agentOf, chatOf, now })) {
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
      const written = yield* SessionInput.admit(db, events, {
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
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (written) told += 1
    }
    return told
  }).pipe(Effect.orElseSucceed(() => 0))
