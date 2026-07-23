export * as MessengerPace from "./pace"

import { Context, Duration, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

// The traffic-rules governor's PACER (notes/messenger-plan.md §2.3, AGENTS.md #9): NovaClaw types
// like one human hand — outbound is serialized GLOBALLY across every chat and account (never two
// chats answered at the same instant), with a per-message delay ≈ the message's length ÷ human
// typing speed. This is the ban-avoidance backbone: providers tolerate automation that behaves,
// and human-paced, no-instant-post output is the single strongest "we're not a spam bot" signal.
// A driver that cannot be paced does not ship.

// A brisk-but-human typist: fast enough that remote control stays usable, slow enough that output
// never bursts or posts instantly (the actual ban trigger). All three are tunable per account
// later; the anti-ban property is the SHAPE — serialize globally, delay per length, clamp — not
// the exact ms.
/** ~15 chars/s ≈ 180 wpm — a fast human, never a machine gun. */
export const CHARS_PER_SECOND = 15
/** Even a one-word reply doesn't post instantly (reading + a beat). */
export const MIN_DELAY_MS = 700
/** No single message "types" longer than this — long text is chunked upstream anyway. */
export const MAX_DELAY_MS = 6_000
/** A small gap after each send so back-to-back messages don't butt together. */
export const INTER_MESSAGE_GAP_MS = 500

export interface PaceOptions {
  readonly charsPerSecond?: number
  readonly minMs?: number
  readonly maxMs?: number
}

// Per-account typing-speed bounds (the Settings → Messengers control). The user MAY go fast, but a
// hard ceiling keeps even a reckless setting from effectively turning pacing off (which is what
// gets an account banned). Above RISKY the UI shows a ban warning.
export const PACE_CPS_DEFAULT = CHARS_PER_SECOND
export const PACE_CPS_MIN = 3
export const PACE_CPS_MAX = 80
export const PACE_CPS_RISKY = 30
/** The account-settings key the Messengers tab writes the per-account typing speed into. */
export const PACE_SETTING_KEY = "paceCharsPerSecond"

/** Read the per-account pacing from account settings (empty/invalid → the human default), clamped to
 *  the safe range. Only the typing SPEED is user-tunable; the min/max clamps stay at their defaults. */
export const paceFromSettings = (settings: Record<string, string>): PaceOptions | undefined => {
  const raw = Number((settings[PACE_SETTING_KEY] ?? "").trim())
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  return { charsPerSecond: Math.min(PACE_CPS_MAX, Math.max(PACE_CPS_MIN, raw)) }
}

/** The human-typing delay for one outbound message, in ms. Pure — unit-tested. */
export const typingDelayMs = (text: string, options?: PaceOptions): number => {
  const cps = options?.charsPerSecond ?? CHARS_PER_SECOND
  const min = options?.minMs ?? MIN_DELAY_MS
  const max = options?.maxMs ?? MAX_DELAY_MS
  const typed = (text.length / cps) * 1000
  return Math.round(Math.min(max, Math.max(min, typed)))
}

export interface Pacer {
  /** Run one outbound send under the global pace: acquire the single "hand", wait the typing
   *  delay for `text`, perform `send`, then a small gap before releasing. Serializes ALL sends.
   *  `perСall` overrides the typing speed / clamps for THIS message (per-account setting, §2.3) —
   *  the serialization ("one hand") stays global no matter what. */
  readonly paced: <A, E, R>(
    text: string,
    send: Effect.Effect<A, E, R>,
    perCall?: PaceOptions,
  ) => Effect.Effect<A, E, R>
}

/** Build a process-global pacer. `sleep` is injectable so tests run instantly while still proving
 *  the serialization (one send at a time) and delay ordering. */
export const make = (options?: PaceOptions & { readonly sleep?: (ms: number) => Effect.Effect<void> }): Pacer => {
  const gate = Semaphore.makeUnsafe(1) // one hand — the whole point of "across all chats"
  const sleep = options?.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)))
  const gap = options?.sleep !== undefined ? 0 : INTER_MESSAGE_GAP_MS
  return {
    paced: (text, send, perCall) =>
      gate.withPermit(
        Effect.gen(function* () {
          // Per-account speed/clamps override the pacer defaults for this message; a test-injected
          // `sleep` still wins so the suite stays instant.
          yield* sleep(typingDelayMs(text, { ...options, ...perCall }))
          const result = yield* send
          yield* sleep(gap)
          return result
        }),
      ),
  }
}

// The pacer as an injectable global service, so the gateway depends on ONE shared pacer and tests
// can swap in an instant one (the LOGIC under test is cold-start/challenge/relay routing; the real
// timing + serialization is proven directly in messenger-pace.test.ts).
export class Service extends Context.Service<Service, Pacer>()("@novaclaw/v2/MessengerPace") {}

export const layer = Layer.sync(Service, () => make())

/** Test/override layer — e.g. `layerWith({ sleep: () => Effect.void })` for instant, still-serialized pacing. */
export const layerWith = (options: PaceOptions & { readonly sleep?: (ms: number) => Effect.Effect<void> }) =>
  Layer.sync(Service, () => make(options))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
