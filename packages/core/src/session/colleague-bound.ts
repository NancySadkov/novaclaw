export * as ColleagueBound from "./colleague-bound"

/**
 * How many colleague-to-colleague hops may happen without the user saying anything.
 *
 * Four is deliberate: it clears the two shapes that legitimately occur — a straight ask→answer (2)
 * and a delegate→ask→answer→report (4) — and stops the third hand-off that would begin a round the
 * user never asked for. Messages are still stored; this caps only immediate execution.
 */
export const HOP_CAP = 4

/** Immediate wakes one sender may trigger inside {@link RATE_WINDOW_MS}. */
export const RATE_LIMIT = 8

/** The rate window. Ten minutes: long enough that a real exchange never touches it. */
export const RATE_WINDOW_MS = 10 * 60_000

/**
 * The hop this delivery would be.
 *
 * ⚠️ `undefined` incoming means ZERO, not "unknown": a colleague writing with nothing peer-shaped
 * behind it is starting a chain, and the first hand-off is hop 1. Treating unknown as anything else
 * would make every message sent by a colleague the user just spoke to look like a continuation.
 */
export const nextHop = (incoming: number | undefined): number => (incoming === undefined ? 0 : incoming) + 1

/** Would this hand-off exceed the immediate-wake budget? */
export const exceedsHopCap = (hop: number): boolean => hop > HOP_CAP

/** Which messages inside the window still count. Pure so the trim rule is testable without a clock. */
export const fresh = (sent: readonly number[], at: number): number[] =>
  sent.filter((when) => at - when <= RATE_WINDOW_MS)

/** Is a sender at its wake limit, given what it has already started? */
export const overRate = (sent: readonly number[], at: number): boolean => fresh(sent, at).length >= RATE_LIMIT

// ⚠️ Process-lifetime, like `ModelHealth`: a rate window that survived a restart would punish a
// colleague for what it did before the machine came back, and the window is short enough that losing
// it costs nothing. Keyed by SENDER, so one loud colleague never spends another's allowance.
const sent = new Map<string, number[]>()

/** Reserve one immediate wake before an asynchronous admission can race another send. */
export const record = (sender: string, at: number): void => {
  sent.set(sender, [...fresh(sent.get(sender) ?? [], at), at])
}

/**
 * Can this sender afford to wake `count` colleagues AT ONCE?
 *
 * 🔴 A broadcast charges the bound ONCE PER RECIPIENT, so a group of six turns one lap into six.
 * Asking `rateExceeded` and then waking N times would check a budget of one against a spend of
 * N — the bound would still be there, and it would be wrong by a factor of the group size.
 *
 * The wake decision is all-or-nothing. Every recipient still receives a durable copy.
 */
export const hasCapacityFor = (sender: string, at: number, count: number): boolean =>
  fresh(sent.get(sender) ?? [], at).length + count <= RATE_LIMIT

/** Charge the bound once per recipient — see `hasCapacityFor`. */
export const recordMany = (sender: string, at: number, count: number): void => {
  for (let index = 0; index < count; index += 1) record(sender, at)
}

/**
 * THE PATH — a cycle is decidable at the hop that would close it.
 *
 * 🔴 `hops` is a number, so `A→B→C→A` and `A→B→C→D` are the same fact to it. A loop is therefore
 * this path lets the caller defer execution while preserving the actual message.
 *
 * ⚠️ Every id here is an AGENT id, never a session: one chat per agent, so the agent is the node.
 */

/** The path this hop would carry: what arrived, plus the sender appending itself. */
export const extendPath = (incoming: ReadonlyArray<string> | undefined, sender: string | undefined): string[] => {
  const path = [...(incoming ?? [])]
  // A sender we cannot name cannot be appended — and must not silently shorten the path either, so
  // the rest is preserved and the check simply has one fewer node to match on.
  if (sender !== undefined && sender !== "") path.push(sender)
  return path
}

/**
 * Would delivering to `target` close a cycle?
 *
 * 🔴 **An ANSWER back to whoever asked you is not a cycle — it is the exchange ending.** `A→B→A` is
 * the normal round trip and appears on the path exactly like `A→B→C→A` does; only the TURN separates
 * them. Refusing the answer breaks every ordinary hand-off, which is what a first cut of this did:
 * `deliver(theron → aris)` after aris had asked theron read as a loop.
 *
 * So the check applies to an ASK being passed onward, never to an answer going back.
 */
export const closesCycle = (input: {
  readonly path: ReadonlyArray<string>
  readonly target: string
  readonly answering: boolean
  /**
   * Everyone in the ROOM this message belongs to, if it belongs to one.
   *
   * 🔴 **A conference is not a chain, and applying the chain's rule to it broke the room.** A
   * bystander's own note invites it to address the group — and every participant is already ON the
   * path, because that is how they were reached. So the invited speak-up was accepted for everyone
   * except the ORIGINATOR, who was dropped as a cycle: the room asked for a reply and then refused
   * to deliver it to the person who asked, with nothing telling the bystander.
   *
   * `answering` does not cover this: it exempts the ONE party you are replying to, and a bystander
   * is not replying to the asker.
   *
   * ⚠️ This exempts the room from the CYCLE rule only. The hop cap and the rate window still apply
   * unchanged, so a room cannot loop for ever — it runs out of budget like anything else. And it is
   * scoped to the CURRENT participants: an id that has left the room is a cycle again.
   */
  readonly room?: ReadonlyArray<string> | undefined
}): boolean => {
  if (input.answering) return false
  if (input.room !== undefined && input.room.includes(input.target)) return false
  return input.path.includes(input.target)
}

/** Is this sender over its immediate-wake budget right now? */
export const rateExceeded = (sender: string, at: number): boolean => overRate(sent.get(sender) ?? [], at)

/** How many immediate wakes this sender has on record inside the window. */
export const recent = (sender: string, at: number): number => fresh(sent.get(sender) ?? [], at).length

/** Test seam: forget every sender's window. */
export const reset = (): void => {
  sent.clear()
}
