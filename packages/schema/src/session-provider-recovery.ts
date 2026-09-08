export * as SessionProviderRecovery from "./session-provider-recovery"

import { Schema } from "effect"
import { Event } from "./event"
import { Model } from "./model"
import { DateTimeUtcFromMillis } from "./schema"
import { SessionMessage } from "./session-message"

/**
 * A provider turn durably admitted before its network dispatch but never observed at an ordinary
 * settlement boundary. While the process is alive this is simply the active turn; after restart it
 * is proof that automatic replay would be unsafe and fresh user authority is required.
 */
export const Info = Schema.Struct({
  attemptID: Event.ID,
  assistantMessageID: SessionMessage.ID,
  model: Model.Ref,
  startedAt: DateTimeUtcFromMillis,
  toolProtocol: Schema.Boolean,
}).annotate({ identifier: "Session.ProviderRecovery" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
