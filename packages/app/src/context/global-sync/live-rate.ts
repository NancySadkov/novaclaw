// Live generation telemetry for the Chats task-manager (todo.md ps row — status · tokens):
// approximate tokens + tokens/sec for a RUNNING agent, derived client-side from the SSE
// text/reasoning delta stream. The server's authoritative usage lands only at step end
// (applyUsage → session.updated), so within a step the only live signal is the delta chars;
// the char→token conversion is the shared `Token.estimateFromChars` (chars/4) and the UI labels it
// "~". We track a running char count (not the text), so the CJK-aware `Token.estimate` can't apply.
// PURE — the server-session store owns the per-session state map and the throttled signal.
//
// ⚠️ Samples are timestamped with the delta's OWN generation time (the event's server `timestamp`),
// never with its arrival. A renderer that was hidden, suspended or otherwise stalled receives the
// deltas generated while it was away as one burst whose arrival times are all "now"; measuring that
// burst against its own duration fabricates a throughput spike (owner-hit 2026-09-19: the Home tile
// read ~4000 t/s for a moment on window focus). The generation time survives the delay, so the
// window still answers "how fast is it generating?". Clients that carry no timestamp fall back to
// arrival time, which is exact for the live path they were on before the stall.

import { Token } from "@novaclaw/core/util/token"
import * as Timestamp from "@novaclaw/schema/time"

/** The t/s window: long enough to smooth chunk jitter, short enough to feel live. */
const WINDOW_MS = 10_000
/** Coalesce bursts so the sample ring stays tiny even at token-per-chunk stream rates. */
const SAMPLE_BUCKET_MS = 250

export interface LiveRateState {
  /** Total streamed chars this run (since the tracker was created/cleared). */
  chars: number
  /** Generated characters attributable specifically to the active compaction pass. */
  compactionChars: number
  samples: Array<{ at: number; chars: number }>
}

export const createState = (): LiveRateState => ({ chars: 0, compactionChars: 0, samples: [] })

export function note(
  state: LiveRateState,
  chars: number,
  now: number,
  source: "generation" | "compaction" = "generation",
  at: number = now,
): void {
  if (chars <= 0) return
  state.chars += chars
  if (source === "compaction") state.compactionChars += chars
  const last = state.samples[state.samples.length - 1]
  // Order by GENERATION time (`at`), not arrival (`now`): a stalled client's backlog keeps its real
  // spread instead of collapsing onto one instant. `when` is kept monotonic so a delta that arrives
  // out of order can only join the sample it precedes, never rewind the window.
  const when = last && at < last.at ? last.at : at
  if (last && when - last.at < SAMPLE_BUCKET_MS) last.chars += chars
  else state.samples.push({ at: when, chars })
  while (state.samples.length > 0 && when - state.samples[0]!.at > WINDOW_MS) state.samples.shift()
}

export interface LiveRateSnapshot {
  /** ~tokens streamed this run (Token.estimateFromChars over the accumulated char count). */
  readonly approxTokens: number
  /** ~tokens streamed by the active context-compaction pass. */
  readonly approxCompactionTokens: number
  /** ~tokens/sec over the recent window; 0 when the stream has gone quiet. */
  readonly tps: number
}

/**
 * Every live event that carries MODEL-GENERATED characters.
 *
 * Keep this vocabulary beside the rate accumulator rather than at its SSE caller. Text and
 * reasoning are only two presentations of model output: a large file write arrives as streamed
 * tool input, and a summary produced during compaction arrives on its own channel. Omitting either
 * makes the same model appear to stop while it is visibly doing useful work.
 */
export function generatedDelta(event: {
  readonly type: string
  readonly properties?: unknown
}):
  | {
      readonly sessionID: string
      readonly chars: number
      readonly source: "generation" | "compaction"
      /** The delta's own generation time (server epoch millis); absent on a client that did not send one. */
      readonly at?: number
    }
  | undefined {
  const properties = event.properties
  if (properties === null || typeof properties !== "object") return undefined
  const sessionID = "sessionID" in properties ? properties.sessionID : undefined
  if (typeof sessionID !== "string") return undefined
  // `toEpochMillis`, not a cast: the SSE wire sends epoch millis, but stale live clients and decoded
  // in-process values may hand us an ISO string or Date — the same mixed-encoding seam `time.ts` exists for.
  const at = "timestamp" in properties ? Timestamp.toEpochMillis(properties.timestamp) : undefined
  const stamp = at === undefined ? {} : { at }

  if (
    event.type === "session.next.text.delta" ||
    event.type === "session.next.reasoning.delta" ||
    event.type === "session.next.tool.input.delta"
  ) {
    const delta = "delta" in properties ? properties.delta : undefined
    return typeof delta === "string" && delta.length > 0
      ? { sessionID, chars: delta.length, source: "generation", ...stamp }
      : undefined
  }
  if (event.type === "session.next.compaction.delta") {
    const text = "text" in properties ? properties.text : undefined
    return typeof text === "string" && text.length > 0
      ? { sessionID, chars: text.length, source: "compaction", ...stamp }
      : undefined
  }
  return undefined
}

export function snapshot(state: LiveRateState, now: number): LiveRateSnapshot {
  const inWindow = state.samples.filter((sample) => now - sample.at <= WINDOW_MS)
  const windowChars = inWindow.reduce((total, sample) => total + sample.chars, 0)
  const spanMs = inWindow.length > 0 ? Math.max(1000, now - inWindow[0]!.at) : 1000
  return {
    approxTokens: Token.estimateFromChars(state.chars),
    approxCompactionTokens: Token.estimateFromChars(state.compactionChars),
    // Keep the measurement numeric and unrounded. The presentation surfaces share one formatter,
    // so a measured 0.24 t/s reads as 0.2 instead of the misleading integer 1.
    tps: Token.estimateFromChars(windowChars) / (spanMs / 1000),
  }
}
