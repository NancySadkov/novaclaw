export * as SessionTags from "./session-tags"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

// The tags component on the session entity (notes/entities.md): free-form user/agent labels that
// organize chat processes (tagging a thread ROOT organizes its tree). One event carries the full
// per-session tag list — idempotent client folds, no add/remove ordering to reconcile.
const Updated = define({
  type: "session.tags.updated",
  schema: {
    sessionID: SessionID,
    tags: Schema.Array(Schema.String),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
