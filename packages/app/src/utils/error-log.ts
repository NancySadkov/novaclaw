import { createSignal } from "solid-js"
import * as Timestamp from "@novaclaw/schema/time"

// Dependability P5 (uix-dependability-plan): the client-side error ring buffer behind the Debug
// app's Error-log panel. The calm surfaces (reconnect banner, ErrorPage) stay clean — THIS is
// where raw detail lives. Bounded and truncate-at-capture so a pathological error storm can never
// retain huge objects; the console taps guard re-entrancy so a tap that itself throws or logs
// cannot recurse.

// ⚠️ `notice` was added 2026-07-28 for a fault that is NOT a fault in the user's install. The
// release-notes fetch (context/highlights.tsx) hands its unavailable-line here, and OUR changelog file
// 404s — so every launch wrote a `warn` accusing the user's machine of something our CDN was doing.
// A warning the user can neither cause nor fix trains them to ignore warnings, which is how the one
// that matters gets missed. `notice` is the honest level: recorded, named, not alarming.
// ⚠️ A new level MUST also be given a colour in the Debug app's Error-log panel (pages/debug.tsx) —
// its `classList` matches levels by name, so an undeclared level renders in the inherited colour and
// reads as a rendering bug rather than a level.
export interface ErrorLogEntry {
  readonly at: number
  readonly level: "error" | "warn" | "notice" | "uncaught" | "rejection"
  readonly text: string
}

const MAX_ENTRIES = 200
const MAX_TEXT = 2_000
export const CLIENT_LOG_BATCH_SIZE = 8
const CLIENT_LOG_RETRY_MS = 1_000

export type ClientLogSender = (entry: ErrorLogEntry) => Promise<boolean>

/**
 * A bounded, asynchronous bridge from the renderer ring to the instance log.
 *
 * Measured 2026-08-09 over a full 200-entry ring with a 50 ms sender: concurrency 1 drained in
 * 11.46 s, 4 in 2.87 s, 8 in 1.41 s, and eager dispatch in 55.8 ms while putting all 200 requests
 * in flight. Eight is the useful middle: it finishes a remote/LAN flush promptly without turning a
 * renderer crash into a request storm. Enqueue only schedules a microtask; it never calls the SDK
 * on the console/window-error stack.
 *
 * A transport rejection retains the entry and retries after a quiet second. A resolved `false` is
 * NOT retried: the instance's limiter deliberately refused it, and fighting that answer would
 * defeat the write-amplification bound. The queue keeps the newest ring-sized window while offline.
 */
export function createClientLogDrain(
  options: {
    readonly soon?: (run: () => void) => void
    readonly later?: (run: () => void, milliseconds: number) => unknown
    readonly cancelLater?: (handle: unknown) => void
    readonly batchSize?: number
    readonly capacity?: number
  } = {},
) {
  const soon = options.soon ?? queueMicrotask
  const later = options.later ?? ((run, milliseconds) => setTimeout(run, milliseconds))
  const cancelLater = options.cancelLater ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const batchSize = options.batchSize ?? CLIENT_LOG_BATCH_SIZE
  const capacity = options.capacity ?? MAX_ENTRIES

  let pending: ErrorLogEntry[] = []
  let sender: ClientLogSender | undefined
  let scheduled = false
  let draining = false
  let retry: unknown

  const schedule = () => {
    if (scheduled || draining || retry !== undefined || sender === undefined || pending.length === 0) return
    scheduled = true
    soon(drain)
  }

  const drain = () => {
    scheduled = false
    if (draining || sender === undefined || pending.length === 0) return
    draining = true
    const target = sender
    const batch = pending.splice(0, batchSize)
    void Promise.allSettled(batch.map((entry) => target(entry))).then((results) => {
      const failed = batch.filter((_, index) => results[index]?.status === "rejected")
      if (failed.length > 0) pending = [...failed, ...pending].slice(-capacity)
      draining = false
      if (failed.length === 0) {
        schedule()
        return
      }
      retry = later(() => {
        retry = undefined
        schedule()
      }, CLIENT_LOG_RETRY_MS)
    })
  }

  return {
    enqueue(entry: ErrorLogEntry) {
      pending = [...pending, entry].slice(-capacity)
      schedule()
    },
    use(next: ClientLogSender | undefined) {
      sender = next
      if (retry !== undefined) {
        cancelLater(retry)
        retry = undefined
      }
      schedule()
    },
    remove(candidate: ClientLogSender) {
      if (sender === candidate) sender = undefined
    },
    pending: () => pending.length,
  }
}

const clientLogDrain = createClientLogDrain()

/** Install the currently selected instance as the drain target. */
export function installClientLogSender(sender: ClientLogSender): () => void {
  clientLogDrain.use(sender)
  return () => clientLogDrain.remove(sender)
}

/** The wire has four severity levels; retain the renderer's richer arrival kind as metadata. */
export function clientLogPayload(entry: ErrorLogEntry) {
  return {
    service: "renderer",
    level:
      entry.level === "warn" ? ("warn" as const) : entry.level === "notice" ? ("info" as const) : ("error" as const),
    message: entry.text,
    extra: {
      kind: entry.level,
      at: Timestamp.toISOString(entry.at) ?? "unknown-time",
    },
  }
}

const [entries, setEntries] = createSignal<readonly ErrorLogEntry[]>([])

/** Reactive accessor for the panel (newest LAST — the panel decides display order). */
export const errorLogEntries = entries

export function clearErrorLog() {
  setEntries([])
}

function toText(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function pushErrorLog(level: ErrorLogEntry["level"], parts: readonly unknown[]) {
  const text = parts.map(toText).join(" ").slice(0, MAX_TEXT)
  const entry: ErrorLogEntry = { at: Date.now(), level, text }
  setEntries((prev) =>
    prev.length >= MAX_ENTRIES ? [...prev.slice(prev.length - MAX_ENTRIES + 1), entry] : [...prev, entry],
  )
  // This must never make the console/window-error path throw. The drain itself is asynchronous,
  // but guard the hand-off too so a future scheduler implementation cannot break capture.
  try {
    clientLogDrain.enqueue(entry)
  } catch {
    // The in-memory ring remains the always-available fallback.
  }
}

/**
 * Record something worth knowing that is not a defect in the user's install — a subsystem of OURS that
 * is unavailable, an answer from our own infrastructure. Goes to the Debug app's Error-log panel
 * at `notice`, and to the console at `info` so it still reaches the dev stdout.
 *
 * ⚠️ Deliberately NOT `console.warn`: that is tapped above and would land at level `warn`, which is the
 * claim "something is wrong with your machine". Use `console.warn` when that claim is true.
 */
export function noticeErrorLog(text: string) {
  pushErrorLog("notice", [text])
  // eslint-disable-next-line no-console
  console.info(text)
}

let installed = false
let inTap = false

/** Install the window/console taps once per window. Called from the app root so capture starts at
 *  boot, not when the Debug panel first opens. */
export function installErrorLog() {
  if (installed || typeof window === "undefined") return
  installed = true

  window.addEventListener("error", (event) => {
    // Resource-load errors (img/script) surface as bare Events with no message — skip those.
    if (!(event instanceof ErrorEvent)) return
    pushErrorLog("uncaught", [event.error ?? event.message])
  })
  window.addEventListener("unhandledrejection", (event) => {
    pushErrorLog("rejection", [event.reason])
  })

  const tap =
    (level: "error" | "warn", original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original.apply(console, args)
      if (inTap) return
      inTap = true
      try {
        pushErrorLog(level, args)
      } catch {
        // never let the tap break logging
      } finally {
        inTap = false
      }
    }
  // eslint-disable-next-line no-console
  console.error = tap("error", console.error.bind(console))
  // eslint-disable-next-line no-console
  console.warn = tap("warn", console.warn.bind(console))
}
