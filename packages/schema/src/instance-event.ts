export * as InstanceEvent from "./instance-event"

import { Schema } from "effect"
import { Event } from "./event"

/**
 * An instance was disposed — every accepted config write disposes every instance, and a client
 * with a turn in flight there needs to know why its run did not finish.
 *
 * ⚠️ Until 2026-09-03 this was a `GlobalBus` IPC payload relayed only by the legacy `/event` stream
 * (and still by `/global/event`), which made it the one type the CLI could read there and nowhere
 * in the contract. Served on `/api/event` now, filtered by the reader on `directory`: the contract
 * stream is instance-wide, so a subscriber sees every directory's disposal and keeps its own.
 */
export const Disposed = Event.define({ type: "server.instance.disposed", schema: { directory: Schema.String } })

export const Definitions = Event.inventory(Disposed)
