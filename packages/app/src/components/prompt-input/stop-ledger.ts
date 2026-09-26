/**
 * What the composer's Stop/Send control did with each press, and what it saw when pressed.
 *
 * 🔴 Added after three rounds of Stop-button fixes all verified green in isolation while clicks
 * stayed dead in one real setup (owner, 2026-09-26: Daedalus streaming, roster Working, tab dot
 * missing, clicks ignored, Esc working). Every theory since has been about TIMING nobody
 * recorded — which signal was which value at click time. This ring records exactly that, so the
 * next probe answers instead of guessing.
 *
 * Bounded (50 entries) and side-effect free: it never alters the decision, only describes it. The
 * summary travels on `window.__novaStopLedger` for live diagnosis (the web preview reads it back
 * after synthetic clicks) and as a `console.debug` line the dev build forwards to its stdout.
 */
export type StopLedgerAction =
  /** The click ran `abort()` — Esc's path. */
  | "abort"
  /** The click fell through to the form submit (button did not read working). */
  | "submit-path"
  /** `handleSubmit` itself stopped on an empty composer while working. */
  | "submit-abort"
  /** `handleSubmit` queued a follow-up while working. */
  | "submit-send"

export interface StopLedgerEntry {
  readonly at: number
  readonly sessionID: string | undefined
  /** What the control showed: the spinner, Stop, play (resume), or Send. */
  readonly shown: "spinner" | "stop" | "play" | "send"
  readonly working: boolean
  readonly blank: boolean
  readonly resuming: boolean
  readonly action: StopLedgerAction
}

const LIMIT = 50
const entries: StopLedgerEntry[] = []

export function pushStopLedger(entry: Omit<StopLedgerEntry, "at">): StopLedgerEntry {
  const full = { ...entry, at: Date.now() }
  entries.push(full)
  while (entries.length > LIMIT) entries.shift()
  try {
    const scope = globalThis as unknown as { __novaStopLedger?: StopLedgerEntry[] }
    scope.__novaStopLedger = entries.slice()
  } catch {
    /* a ledger that cannot publish still kept its ring */
  }
  try {
    console.debug(
      `[stop-ledger] ${entry.action} shown=${entry.shown} working=${entry.working} ` +
        `blank=${entry.blank} resuming=${entry.resuming} session=${entry.sessionID ?? "none"}`,
    )
  } catch {
    /* logging must never break the composer */
  }
  return full
}

export function readStopLedger(): readonly StopLedgerEntry[] {
  return entries.slice()
}

export function clearStopLedger(): void {
  entries.length = 0
}
