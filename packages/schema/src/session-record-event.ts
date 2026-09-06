export * as SessionRecordEvent from "./session-record-event"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { Session } from "./session"
import { SessionID } from "./session-id"
import { Delivery } from "./session-delivery"
import { DateTimeUtcFromMillis } from "./schema"
import { Prompt } from "./prompt"
import { SessionMessage } from "./session-message"

// V1-nuke slice D: the session RECORD lifecycle events, native vocabulary. The type strings are
// the ones the tree has always used ("session.created/updated/deleted" — every consumer matches
// on type), but the payload is the NATIVE `Session.Info` (the V1 wire SessionInfo died with
// schema/v1). Durable version bumps to 2 for the payload change — replay of old-version rows is
// skip-on-decode, the established tolerance (pre-release, throwaway dev logs by decree).
// `session.diff` died here too (no publisher anywhere); `session.error` stays, carrying the
// generic error object its publishers (plugin host, skills) actually send.

const options = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

/** The opening input belongs to creation, so its durable projection cannot be stranded between two events. */
export const OpeningPrompt = Schema.Struct({
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
  timestamp: DateTimeUtcFromMillis,
})
export type OpeningPrompt = typeof OpeningPrompt.Type

export const Created = define({
  type: "session.created",
  ...options,
  schema: {
    sessionID: SessionID,
    info: Session.Info,
    openingPrompt: Schema.optional(OpeningPrompt),
  },
})

export const Updated = define({
  type: "session.updated",
  ...options,
  schema: {
    sessionID: SessionID,
    info: Session.Info,
    /** A typed restore must clear the nullable archive column during projection. */
    clearArchived: Schema.optional(Schema.Boolean),
  },
})

export const Deleted = define({
  type: "session.deleted",
  ...options,
  schema: {
    sessionID: SessionID,
    info: Session.Info,
  },
})

export const Error = define({
  type: "session.error",
  schema: {
    sessionID: Schema.optional(SessionID),
    error: Schema.Unknown,
  },
})

export const Definitions = inventory(Created, Updated, Deleted, Error)
