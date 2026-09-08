export type ToastHistoryEntry = {
  readonly title?: string
  readonly description?: string
  readonly variant: "default" | "success" | "error" | "loading"
  readonly time: number
}

type Listener = (entry: ToastHistoryEntry) => boolean

const listeners = new Set<Listener>()
const pending: ToastHistoryEntry[] = []
const PENDING_LIMIT = 50

/**
 * The toast facade can run before the notification provider has mounted. Buffer that short boot
 * window and hand it to the first durable subscriber; after that, the provider's persisted ledger
 * is the source of truth. This module deliberately stores no browser data of its own.
 */
export function recordToastHistory(entry: ToastHistoryEntry) {
  if (listeners.size === 0) {
    pending.push(entry)
    if (pending.length > PENDING_LIMIT) pending.splice(0, pending.length - PENDING_LIMIT)
    return
  }
  let accepted = false
  for (const listener of listeners) accepted = listener(entry) || accepted
  if (!accepted) {
    pending.push(entry)
    if (pending.length > PENDING_LIMIT) pending.splice(0, pending.length - PENDING_LIMIT)
  }
}

export function flushToastHistory() {
  if (pending.length === 0 || listeners.size === 0) return
  const buffered = pending.splice(0)
  for (const entry of buffered) {
    let accepted = false
    for (const listener of listeners) accepted = listener(entry) || accepted
    if (!accepted) pending.push(entry)
  }
}

export function subscribeToastHistory(listener: Listener) {
  listeners.add(listener)
  flushToastHistory()
  return () => listeners.delete(listener)
}
