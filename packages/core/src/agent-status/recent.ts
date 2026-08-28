import type { SessionMessage } from "../session/schema"

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

const textOf = (message: SessionMessage.Message): string => {
  const parts = (message as unknown as { parts?: { type?: string; text?: string }[] }).parts ?? []
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter((text) => text.length > 0)
    .join("\n")
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
    const text = textOf(message)
    if (!text) continue
    const role = (message as unknown as { role?: string }).role ?? "assistant"
    lines.push(`${role}: ${text}`)
  }
  if (lines.length === 0) return undefined
  const joined = lines.join("\n")
  return joined.length > MAX_CHARS ? joined.slice(joined.length - MAX_CHARS) : joined
}
