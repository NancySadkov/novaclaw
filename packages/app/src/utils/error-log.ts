import { createSignal } from "solid-js"

// Dependability P5 (uix-dependability-plan): the client-side error ring buffer behind the Debug
// app's Error-log panel. The calm surfaces (reconnect banner, ErrorPage) stay clean — THIS is
// where raw detail lives. Bounded and truncate-at-capture so a pathological error storm can never
// retain huge objects; the console taps guard re-entrancy so a tap that itself throws or logs
// cannot recurse.

export interface ErrorLogEntry {
  readonly at: number
  readonly level: "error" | "warn" | "uncaught" | "rejection"
  readonly text: string
}

const MAX_ENTRIES = 200
const MAX_TEXT = 2_000

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
  setEntries((prev) => (prev.length >= MAX_ENTRIES ? [...prev.slice(prev.length - MAX_ENTRIES + 1), entry] : [...prev, entry]))
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
