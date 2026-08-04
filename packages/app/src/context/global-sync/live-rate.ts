// Live generation telemetry for the Chats task-manager (todo.md ps row — status · tokens):
// approximate tokens + tokens/sec for a RUNNING agent, derived client-side from the SSE
// text/reasoning delta stream. The server's authoritative usage lands only at step end
// (applyUsage → session.updated), so within a step the only live signal is the delta chars;
// the char→token conversion is the shared `Token.estimateFromChars` (chars/4) and the UI labels it
// "~". We track a running char count (not the text), so the CJK-aware `Token.estimate` can't apply.
// PURE — the server-session store owns the per-session state map and the throttled signal.

import { Token } from "@novaclaw/core/util/token"

/** The t/s window: long enough to smooth chunk jitter, short enough to feel live. */
const WINDOW_MS = 10_000
/** Coalesce bursts so the sample ring stays tiny even at token-per-chunk stream rates. */
const SAMPLE_BUCKET_MS = 250

export interface LiveRateState {
  /** Total streamed chars this run (since the tracker was created/cleared). */
  chars: number
  samples: Array<{ at: number; chars: number }>
}

export const createState = (): LiveRateState => ({ chars: 0, samples: [] })

export function note(state: LiveRateState, chars: number, now: number): void {
  if (chars <= 0) return
  state.chars += chars
  const last = state.samples[state.samples.length - 1]
  if (last && now - last.at < SAMPLE_BUCKET_MS) last.chars += chars
  else state.samples.push({ at: now, chars })
  while (state.samples.length > 0 && now - state.samples[0]!.at > WINDOW_MS) state.samples.shift()
}

export interface LiveRateSnapshot {
  /** ~tokens streamed this run (Token.estimateFromChars over the accumulated char count). */
  readonly approxTokens: number
  /** ~tokens/sec over the recent window; 0 when the stream has gone quiet. */
  readonly tps: number
}

export function snapshot(state: LiveRateState, now: number): LiveRateSnapshot {
  const inWindow = state.samples.filter((sample) => now - sample.at <= WINDOW_MS)
  const windowChars = inWindow.reduce((total, sample) => total + sample.chars, 0)
  const spanMs = inWindow.length > 0 ? Math.max(1000, now - inWindow[0]!.at) : 1000
  return {
    approxTokens: Token.estimateFromChars(state.chars),
    tps: Math.round(Token.estimateFromChars(windowChars) / (spanMs / 1000)),
  }
}
