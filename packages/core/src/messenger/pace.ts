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
   *  delay for `text`, perform `send`, then a small gap before releasing. Serializes ALL sends. */
  readonly paced: <A, E, R>(text: string, send: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Build a process-global pacer. `sleep` is injectable so tests run instantly while still proving
 *  the serialization (one send at a time) and delay ordering. */
export const make = (options?: PaceOptions & { readonly sleep?: (ms: number) => Effect.Effect<void> }): Pacer => {
  const gate = Semaphore.makeUnsafe(1) // one hand — the whole point of "across all chats"
  const sleep = options?.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)))
  const gap = options?.sleep !== undefined ? 0 : INTER_MESSAGE_GAP_MS
  return {
    paced: (text, send) =>
      gate.withPermit(
        Effect.gen(function* () {
          yield* sleep(typingDelayMs(text, options))
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
