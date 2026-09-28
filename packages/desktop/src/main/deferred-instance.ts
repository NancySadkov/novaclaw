import type { SuperviseStatus } from "@novaclaw/script/supervise"
import type { LocalInstanceOwner } from "./lifecycle"

type LocalOwner = LocalInstanceOwner & {
  state(): SuperviseStatus
  subscribe(listener: (state: SuperviseStatus) => void): () => void
  retain?(): void
}

export function createDeferredInstance(load: () => Promise<LocalOwner>): LocalOwner {
  let closed = false
  let owner: LocalOwner | undefined
  let loading: Promise<LocalOwner> | undefined
  let stopping: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined
  const listeners = new Set<(state: SuperviseStatus) => void>()
  const state = (): SuperviseStatus => owner?.state() ?? { phase: closed ? "stopped" : "running" }
  return {
    state,
    subscribe(listener) {
      listeners.add(listener)
      listener(state())
      return () => {
        listeners.delete(listener)
      }
    },
    async start(signal) {
      signal.throwIfAborted()
      if (closed) throw new Error("NovaClaw is shutting down")
      const instance = await (loading ??= load().then((value) => {
        owner = value
        if (!closed)
          unsubscribe = value.subscribe((update) =>
            listeners.forEach((listener) => {
              try {
                listener(update)
              } catch {}
            }),
          )
        return value
      }))
      signal.throwIfAborted()
      if (closed) throw new Error("NovaClaw is shutting down")
      return instance.start(signal)
    },
    retain() {
      owner?.retain?.()
    },
    stop() {
      if (stopping) return stopping
      closed = true
      unsubscribe?.()
      listeners.clear()
      return (stopping = (async () => {
        const instance = await loading?.catch(() => undefined)
        await instance?.stop()
      })())
    },
  }
}
