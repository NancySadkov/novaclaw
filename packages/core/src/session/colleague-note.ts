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

/** How far a peer exchange runs on its own: a question, and an answer. */
export type Turn = "ask" | "answer"

/**
 * The line appended to a delivered peer message.
 *
 * ⚠️ An ANSWER carries a different note from a question, and that difference is what BOUNDS the
 * exchange. Without it the two notes are symmetric, each inviting a reply, and two colleagues will
 * keep the conversation alive between them for as long as the budget lasts — a loop nobody asked for,
 * paid for by the user. One round trip is the default; anything further has to be a deliberate new
 * `ask`, which a model does only when it actually has something to say.
 */
export const replyNote = (input: { readonly from: string; readonly turn: Turn }): string =>
  input.turn === "ask"
    ? `\n\n[This came from ${input.from}, a colleague. To answer them, call the \`colleague\` tool with ` +
      `op "ask", colleague "${input.from}", and your answer as the message — it lands in their chat the ` +
      `way this landed in yours. Answer once; they are not waiting on you.]`
    : `\n\n[This is ${input.from}'s ANSWER to what you asked them. Nothing further is expected of you — ` +
      `use it and carry on. Only call the \`colleague\` tool again if you have a NEW question for them.]`

/** Whether a delivery is a question or an answer, from what the sender's own chat last received. */
export const turnFor = (input: { readonly askedByRecipient: boolean }): Turn =>
  input.askedByRecipient ? "answer" : "ask"

/** The delivered body: the colleague's own words, then the note. Kept as one function so the two
 *  call sites (the tool and any future one) cannot drift on the spacing or the order. */
export const compose = (input: { readonly message: string; readonly from: string; readonly turn: Turn }): string =>
  `${input.message.trimEnd()}${replyNote({ from: input.from, turn: input.turn })}`
