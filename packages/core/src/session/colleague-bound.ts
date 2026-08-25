export * as ColleagueBound from "./colleague-bound"

// BOUNDING the colleague loop with a mechanism, not a sentence (`notes/named-agents.md`, adopted from
// `notes/survey/agent-office-research.md` §1.1; vision-answered under principle 10).
//
// 🔴 **The whole bound used to be the wording of a note.** `colleague-note.ts` gives an `ask` a note
// inviting one reply and an `answer` a note saying *nothing further is expected of you* — and that
// asymmetry is genuinely the right shape, because it teaches rather than truncates. But it holds
// exactly as long as a floor model reads carefully, and the models this runs on are chosen for being
// small. Principle 12's own warning, turned on us: a rule that names an outcome but no mechanism gets
// implemented by whatever mechanism is cheapest to type.
//
// Two mechanisms, because they fail differently:
//
//   - The **hop cap** bounds a chain that keeps making sense — A asks B, B asks C, C asks A — where
//     every individual hand-off is reasonable and the loop is only visible from above.
//   - The **rate window** bounds a colleague that has stopped reading the note at all and is simply
//     hammering. The hop cap cannot see that one: a model re-asking the same colleague ten times in a
//     row is at hop 1 every time if it never gets a reply back.
//
// ⚠️ **The refusal is TOLD TO THE SENDER**, never silently dropped. A hand-off that is accepted and
// discarded is the exact shape this program spent a week removing — the sender writes its message,
// gets an ok, and waits forever for an answer that was never going to arrive.

/**
 * How many colleague-to-colleague hops may happen without the user saying anything.
 *
 * Four is deliberate: it clears the two shapes that legitimately occur — a straight ask→answer (2)
 * and a delegate→ask→answer→report (4) — and stops the third hand-off that would begin a round the
 * user never asked for. A cap that only cleared ask→answer would refuse the org chart working.
 */
export const HOP_CAP = 4

/** Deliveries one sender may make inside {@link RATE_WINDOW_MS}. */
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

/** Would this hand-off exceed the cap? */
export const exceedsHopCap = (hop: number): boolean => hop > HOP_CAP

/**
 * What the sender is told when the chain is too long.
 *
 * ⚠️ Names the USER as the way forward, because that is the actual remedy: the chain resets when a
 * person speaks, so "take it back to the user" is not a brush-off, it is the mechanism. A refusal
 * that only said "no" would leave a model retrying.
 */
export const hopRefusal = (input: { readonly colleague: string; readonly hop: number }): string =>
  `NOT SENT. Your message to ${input.colleague} was refused and ${input.colleague} has not seen it. ` +
  `This would be hand-off ${input.hop} in a chain of colleague messages with nobody outside it, and ` +
  `the limit is ${HOP_CAP}. Do NOT tell anyone it was delivered. Whatever is still unresolved needs ` +
  `the user now — say what you have, and what you were about to ask ${input.colleague}. The count ` +
  `resets as soon as the user says anything.`

export const rateRefusal = (input: { readonly colleague: string }): string =>
  `NOT SENT. Your message to ${input.colleague} was refused and ${input.colleague} has not seen it. ` +
  `You have sent ${RATE_LIMIT} colleague messages in the last ${Math.round(RATE_WINDOW_MS / 60_000)} ` +
  `minutes, which is the limit. Do NOT tell anyone it was delivered. Wait for a reply to the ones you ` +
  `have already sent, or answer the user directly.`

/** Which messages inside the window still count. Pure so the trim rule is testable without a clock. */
export const fresh = (sent: readonly number[], at: number): number[] =>
  sent.filter((when) => at - when <= RATE_WINDOW_MS)

/** Is a sender at its limit, given what it has already sent? */
export const overRate = (sent: readonly number[], at: number): boolean => fresh(sent, at).length >= RATE_LIMIT

// ⚠️ Process-lifetime, like `ModelHealth`: a rate window that survived a restart would punish a
// colleague for what it did before the machine came back, and the window is short enough that losing
// it costs nothing. Keyed by SENDER, so one loud colleague never spends another's allowance.
const sent = new Map<string, number[]>()

/** Record a delivery this sender actually made. */
export const record = (sender: string, at: number): void => {
  sent.set(sender, [...fresh(sent.get(sender) ?? [], at), at])
}

/**
 * Can this sender afford to address `count` colleagues AT ONCE?
 *
 * 🔴 A broadcast charges the bound ONCE PER RECIPIENT, so a group of six turns one lap into six.
 * Asking `rateExceeded` and then delivering N times would check a budget of one against a spend of
 * N — the bound would still be there, and it would be wrong by a factor of the group size.
 *
 * ⚠️ All-or-nothing on purpose. A partially delivered conference is worse than a refused one: the
 * `participants` list every recipient can see would name colleagues who never got the message, so
 * they would answer a group that was never assembled, and nobody in it could tell.
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
 * caught only when `HOP_CAP` fires — about two laps late — and the refusal says "too deep", which
 * sends a model to wait and try again rather than to go back to the person. Naming the loop is the
 * difference between a bound that stops a thing and a bound that explains it.
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

/**
 * Why that hop was not sent — in the same NOT SENT vocabulary as the other two bounds, and naming
 * the LOOP so it is not mistaken for a depth refusal.
 */
export const cycleRefusal = (input: { readonly colleague: string; readonly path: ReadonlyArray<string> }): string =>
  `NOT SENT. Your message to ${input.colleague} was refused and ${input.colleague} has not seen it. ` +
  `${input.colleague} is already in this chain (${[...input.path, input.colleague].join(" → ")}), ` +
  `so passing it on would close a LOOP rather than make progress. Do NOT tell anyone it was ` +
  `delivered. ⚠️ This is not a depth limit — going around again cannot help, and waiting will not ` +
  `change it. Answer with what the chain already knows, or take it to the USER — the chain resets ` +
  `as soon as a person speaks.`

/** Is this sender over its rate limit right now? */
export const rateExceeded = (sender: string, at: number): boolean => overRate(sent.get(sender) ?? [], at)

/** How many deliveries this sender has on record inside the window. */
export const recent = (sender: string, at: number): number => fresh(sent.get(sender) ?? [], at).length

/** Test seam: forget every sender's window. */
export const reset = (): void => {
  sent.clear()
}
