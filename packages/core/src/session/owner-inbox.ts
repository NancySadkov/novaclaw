import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionV2 } from "../session"
import { SessionMessage } from "./message"
import { resolveSessionMode } from "./mode"
import { SessionSchema } from "./schema"
import type { SessionStore } from "./store"

export class InvalidReply extends Schema.TaggedErrorClass<InvalidReply>()("OwnerInbox.InvalidReply", {
  message: Schema.String,
}) {}

export const reply = Effect.fn("OwnerInbox.reply")(function* (
  deps: {
    db: Database.Interface["db"]
    store: SessionStore.Interface
    sessions: Pick<SessionV2.Interface, "prompt">
  },
  input: { sessionID: SessionSchema.ID; messageID: SessionMessage.ID; replyID: SessionMessage.ID; text: string },
) {
  if (!input.text.trim()) return yield* new InvalidReply({ message: "Write a reply first." })
  if ((yield* resolveSessionMode(deps.db, input.sessionID)) !== "human")
    return yield* new InvalidReply({ message: "Replies are sent from your Human-mode transcript." })
  const stored = yield* deps.store.message(input.messageID)
  if (
    !stored ||
    stored.sessionID !== input.sessionID ||
    stored.message.type !== "colleague" ||
    !stored.message.senderSessionID
  )
    return yield* new InvalidReply({ message: "This message has no officer to reply to." })
  const message = stored.message
  const target = yield* deps.store.get(SessionSchema.ID.make(message.senderSessionID!))
  if (!target) return yield* new InvalidReply({ message: "The sender's chat is no longer available." })
  const deliveredID = SessionMessage.ID.make(
    "msg_" + createHash("sha256").update(`owner-reply:${input.replyID}`).digest("hex").slice(0, 32),
  )
  const delivered = yield* deps.sessions.prompt({
    id: deliveredID,
    sessionID: target.id,
    prompt: { text: input.text },
  })
  yield* deps.sessions.prompt({
    id: input.replyID,
    sessionID: input.sessionID,
    prompt: { text: `Reply to ${message.sender}:\n\n${input.text}` },
    resume: false,
  })
  return { sessionID: delivered.sessionID }
})
