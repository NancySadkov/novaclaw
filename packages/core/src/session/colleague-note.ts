export * as ColleagueNote from "./colleague-note"

// HOW a colleague answers the colleague who just wrote to them (owner, 2026-08-21: *"inserted into
// the colleague's message queue with a note on how they can answer — i.e. what tool, what
// recipient"*).
//
// 🔴 **The note is the whole reply channel.** There is no callback, no blocking wait and no second
// mechanism: the answer travels back the way the question came, as another peer message. That is
// principle 14 read structurally — *answer immediately, or do not ask* forbids a session that waits
// on another party, and two officers waiting on each other is the same defect twice. A message
// carrying its own return address costs one sentence and cannot strand anybody.
//
// ⚠️ **Measured on a live hand-off 2026-08-21, before this existed:** the receiver answered into its
// own chat and the answer stopped there, while the SENDER told the user *"Once they respond in their
// chat, I'll relay the answer to you"* — a promise the product could not keep. A model told who is
// asking will try to answer them; if the route back is not stated it invents one.

/**
 * How far a peer exchange runs on its own: a question, an answer — and, in a room, an ANNOUNCEMENT.
 *
 * 🔴 `announce` is what makes a conference affordable. Adopted from the field's mention gating:
 * *"posts without mentions are announcements — visible in channel history but won't wake anyone up"*.
 * Without it a four-person room amplifies — one question is three wakes, each reply three more — and
 * it converges only when the hop cap or the rate window refuses something. Convergence by refusal is
 * not convergence, and it spends every bystander's context on a question that was not theirs.
 */
export type Turn = "ask" | "answer" | "announce"

/**
 * The line appended to a delivered peer message.
 *
 * ⚠️ An ANSWER carries a different note from a question, and that difference is what BOUNDS the
 * exchange. Without it the two notes are symmetric, each inviting a reply, and two colleagues will
 * keep the conversation alive between them for as long as the budget lasts — a loop nobody asked for,
 * paid for by the user. One round trip is the default; anything further has to be a deliberate new
 * `ask`, which a model does only when it actually has something to say.
 */
export const replyNote = (input: {
  readonly from: string
  readonly turn: Turn
  /**
   * The OTHER people in this conference, when it is one — everyone except the receiver.
   *
   * 🔴 Without this a group message is a BROADCAST, not a conference. The note is the whole
   * reply channel, so a receiver told to answer `from` answers one person, and the rest of the
   * room never hears it — the sender assembled a group and got N private conversations.
   *
   * ⚠️ A reply opens a NEW fan-out carrying the same people, rather than re-joining the id it
   * came from: the receiver would have to echo an id back for that, which is a thing to get
   * wrong for no gain. What bounds the exchange is the hop counter, exactly as in a 1:1.
   */
  readonly group?: ReadonlyArray<string> | undefined
}): string =>
  input.turn === "announce"
    ? `\n\n[${input.from} answered the group. You are being kept informed — nobody is waiting on ` +
      `you and no reply is expected. If you have something the others need, call the \`colleague\` tool ` +
      `with op "ask_group" and say it; otherwise carry on with your own work.]`
    : input.turn === "ask" && input.group !== undefined && input.group.length > 0
    ? `\n\n[This came from ${input.from} and went to all of you. To answer everyone, call the ` +
      `\`colleague\` tool with op "ask_group", colleagues ${JSON.stringify([input.from, ...input.group])}, ` +
      `and your answer as the message — it lands in each of their chats the way this landed in yours. ` +
      `Answer once; nobody is waiting on you.]`
    : input.turn === "ask"
    ? `\n\n[This came from ${input.from}, a colleague. To answer them, call the \`colleague\` tool with ` +
      `op "ask", colleague "${input.from}", and your answer as the message — it lands in their chat the ` +
      `way this landed in yours. Answer once; they are not waiting on you.]`
    : `\n\n[This is ${input.from}'s ANSWER to what you asked them. Nothing further is expected of you — ` +
      `use it and carry on. Only call the \`colleague\` tool again if you have a NEW question for them.]`

/**
 * What the ORIGINATOR is told when a chain it started came back around.
 *
 * 🔴 **The part no surveyed framework does.** Everyone else refuses the hop and tells the sender; the
 * one participant who can actually dissolve the loop is the agent holding the question it is
 * circling, and nobody informs it. Its chat is a door we already have, so this costs no new
 * mechanism — principle 14 satisfied rather than bent.
 *
 * ⚠️ Deliberately NOT a hand-off. It asks for nothing, so it invites no reply and starts no chain: an
 * amplifier attached to a loop detector would be a poor joke.
 */
export const cycleNotice = (input: {
  readonly path: ReadonlyArray<string>
  readonly refusedBy: string
  readonly target: string
}): string =>
  `[A chain you started came back around: ${[...input.path, input.target].join(" → ")}. ` +
  `${input.refusedBy} tried to pass it to ${input.target}, who is already in it, so that hop was ` +
  `refused and nothing was delivered. Nobody is waiting on you — but you hold the question this is ` +
  `circling, so you are the one who can settle it: answer it yourself, or take it to the user.]`

/** Whether a delivery is a question or an answer, from what the sender's own chat last received. */
export const turnFor = (input: { readonly askedByRecipient: boolean }): Turn =>
  input.askedByRecipient ? "answer" : "ask"

/**
 * Does this group delivery ANSWER somebody? If so it is a reply, and only the person being answered
 * is woken — everyone else is informed.
 *
 * ⚠️ Derived from the turns already computed per recipient, so this adds no state and cannot disagree
 * with the notes those recipients receive.
 */
export const isReply = (turns: ReadonlyArray<Turn>): boolean => turns.includes("answer")

/**
 * The colleague's OWN WORDS, with the reply note removed.
 *
 * 🔴 For compaction. The note is a route back, and a route is spent once the exchange is over —
 * summarising it drags a tool instruction (*"call the `colleague` tool with op ask…"*) into the
 * record of a finished conversation, and a group note drags the whole roster in with it, so the
 * summary keeps who was in the room and loses who spoke.
 *
 * ⚠️ Matched on the backticked tool name rather than "a trailing bracket", because a colleague's own
 * message may legitimately end in one. Every note `replyNote` composes names the tool; nothing else
 * this function sees does.
 */
export const stripReplyNote = (text: string): string => {
  const at = text.lastIndexOf("\n\n[")
  if (at < 0) return text
  const tail = text.slice(at)
  if (!tail.trimEnd().endsWith("]") || !tail.includes("`colleague`")) return text
  return text.slice(0, at).trimEnd()
}

/** The delivered body: the colleague's own words, then the note. Kept as one function so the two
 *  call sites (the tool and any future one) cannot drift on the spacing or the order. */
export const compose = (input: {
  readonly message: string
  readonly from: string
  readonly turn: Turn
  readonly group?: ReadonlyArray<string> | undefined
}): string =>
  `${input.message.trimEnd()}${replyNote({ from: input.from, turn: input.turn, group: input.group })}`
