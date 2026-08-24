import { and, eq, gte, isNull } from "drizzle-orm"
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

/** The id a notice for this ask MUST have — deterministic, so the second attempt collides. */
export const noticeID = (input: Stalled): string =>
  `msg_stall_${input.asker}_${input.colleague}_${input.askedAt}`

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
  for (const ask of input.landed) {
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
    const priorInSendersChat = input.landed
      .filter((row) => row.sessionID === askerChat && row.at < ask.at)
      .sort((a, b) => b.at - a.at)[0]
    if (priorInSendersChat?.from === colleague) continue
    // ⚠️ ANY later message from that colleague counts as an answer, not only one that parses as one.
    // A reply the asker can read is the outcome that matters, and a stricter test would report a
    // colleague that answered in its own words as silent — the worst kind of false alarm, because
    // the asker can see the answer sitting in its chat.
    const answered = input.landed.some(
      (reply) => reply.sessionID === askerChat && reply.from === colleague && reply.at > ask.at,
    )
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

    const rows = yield* db
      .select({ session: SessionInputTable.session_id, prompt: SessionInputTable.prompt, at: SessionInputTable.time_created })
      .from(SessionInputTable)
      .where(and(gte(SessionInputTable.time_created, now - LOOKBACK_MS)))
      .all()
      .pipe(Effect.orDie)

    const landed: Landed[] = []
    for (const row of rows) {
      const origin = (row.prompt as { origin?: { via?: string; relation?: string; label?: string } }).origin
      if (origin?.via !== "agent" || origin.relation !== "peer" || typeof origin.label !== "string") continue
      landed.push({ sessionID: String(row.session), from: origin.label, at: Number(row.at) })
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
