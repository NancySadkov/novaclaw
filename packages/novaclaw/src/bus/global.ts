import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

/**
 * The listener cap this bus is sized for, and why it is neither Node's default nor unlimited.
 *
 * ⚠️ **Node's default is ten listeners per channel, and this bus has exactly ONE channel.** Every
 * subscriber attaches to `"event"`: one per connected SSE client (`server/routes/instance/httpapi`),
 * and one per outstanding `control-plane/util.ts` wait. A desktop window, a browser tab, the CLI and
 * a handful of agents' streams cross ten on an ordinary day — at which point Node prints a
 * `MaxListenersExceededWarning` with a stack trace, which the desktop build forwards into the
 * user-visible log as a leak that is not happening. The cap has to be sized to the subscriber count,
 * and ten is a count this bus reaches while perfectly healthy.
 *
 * ⚠️ **Not `0` (unlimited), either.** Unlimited deletes the warning for a leak that IS real. Every
 * site attaches one listener per live connection or outstanding wait and removes it on every exit
 * path, so a four-figure standing count means something has stopped detaching — which is exactly the
 * report this warning exists to make. A number far above every legitimate count and far below a
 * runaway keeps the signal and loses the false alarm.
 */
export const MAX_LISTENERS = 1024

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  constructor() {
    super()
    // In the constructor rather than on the instance below: a second emitter of this class is then
    // capped by construction, not by whoever remembers to raise it.
    this.setMaxListeners(MAX_LISTENERS)
  }

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
