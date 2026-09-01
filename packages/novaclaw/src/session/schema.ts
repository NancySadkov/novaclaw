import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { SessionV2 } from "@novaclaw/core/session"
import { statics } from "@novaclaw/core/schema"

export const SessionID = SessionV2.ID
export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  statics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>
