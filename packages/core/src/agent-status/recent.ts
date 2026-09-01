import type { SessionMessage } from "../session/message"

/**
 * What the label is derived FROM: the tail of a colleague's conversation, as plain text.
 *
 * Its own module, message-shape in and string out, because the interesting decisions here are all
 * about WHICH text — and testing them through a model call would be testing the model.
 */

/** How many trailing messages to consider. Enough for the current task, not the whole history. */
export const RECENT_MESSAGES = 12

/** Hard ceiling on what is sent, so one enormous tool dump cannot become the whole prompt. */
export const MAX_CHARS = 4_000

/**
 * The readable text of one transcript entry, or `undefined`.
 *
 * 🔴 **The shape is `message.type` with `text` on the user-ish members and a typed `content[]` on
 * assistant turns — NOT `message.role` / `message.parts[]`.** Read it from the schema, never from a
 * fixture: a fixture written from the same assumption as the code under test agrees with it by
 * construction, and a suite built that way passes while extracting nothing.
 *
 * ⚠️ TEXT only. An assistant turn's `content[]` also carries `reasoning` and `tool` entries:
 * reasoning is the model talking to itself, and tool payloads are where a transcript's bulk lives —
 * the label prompt forbids naming tools, so feeding either in asks the model to ignore most of what
 * it was given.
 */
const textOf = (message: SessionMessage.Message): { role: string; text: string } | undefined => {
  if (message.type === "assistant") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
    return text ? { role: "assistant", text } : undefined
  }
  // `user`, `synthetic`, `system` and `shell` all carry a flat `text`. The members that do NOT —
  // agent/model/permission switches — are bookkeeping, not conversation.
  const flat = (message as { text?: unknown }).text
  if (typeof flat !== "string" || flat.trim() === "") return undefined
  return { role: message.type, text: flat.trim() }
}

/**
 * The tail of a conversation, oldest-first, as `role: text` lines.
 *
 * ⚠️ The TAIL, not the head. The retired session title read the FIRST user message, because a name
 * for a conversation should not move. A status must move — it answers what is happening now — so it
 * reads the newest end. Using the same input as the titler would produce a line that is permanently
 * about whatever the colleague was asked first.
 *
 * ⚠️ Text parts only. Tool inputs and outputs are where a transcript's bulk lives, and they are the
 * part a status must never quote: the prompt's own rules forbid naming tools, so feeding them in
 * asks the model to ignore most of what it was given.
 *
 * ⚠️ Truncated from the FRONT when it is too long. The newest messages are the ones the label is
 * about, so a cap that dropped the tail would answer the wrong question with a full prompt.
 */
export function recentText(messages: readonly SessionMessage.Message[]): string | undefined {
  const lines: string[] = []
  for (const message of messages.slice(-RECENT_MESSAGES)) {
    const entry = textOf(message)
    if (entry) lines.push(`${entry.role}: ${entry.text}`)
  }
  if (lines.length === 0) return undefined
  const joined = lines.join("\n")
  return joined.length > MAX_CHARS ? joined.slice(joined.length - MAX_CHARS) : joined
}
