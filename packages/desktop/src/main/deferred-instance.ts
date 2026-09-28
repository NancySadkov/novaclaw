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
  // 🔴 `starting` while the real owner is still being acquired, and after a stop `stopped`. This
  // used to answer `running` for an instance that did not exist yet — the same premature claim as
  // every other owner, and the one the renderer's gate is most likely to read first, because this
  // wrapper is what the desktop installs before the sidecar has even been chosen.
  const state = (): SuperviseStatus =>
    owner?.state() ?? (closed ? { phase: "stopped" } : { phase: "starting" })
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
