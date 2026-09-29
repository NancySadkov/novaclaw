/**
 * 🔴 **A CLIENT THAT FELL BEHIND MUST SAY SO, NOT STOP PAINTING.**
 *
 * Measured on the owner's own machine, 2026-09-29, twice, from the logs rather than a guess:
 *
 *  1. 19:55:05.277 `renderer unresponsive`
 *  2. 19:57:01.486 `renderer recovered by reload` (attempt 1)  ← 116 seconds later
 *  3. 19:57:01.496 `renderer unresponsive`  ← 10 ms after the reload
 *  4. 19:57:01.500 `renderer responsive`
 *
 * And the server, in the same window: `server.global.event.overflow` — *"an event stream client fell
 * behind and was disconnected to force a resync"*, with **6,712 events buffered**.
 *
 * So the sequence is not a freeze. It is: the server sheds a slow client, the client reconnects and
 * asks for a resync, the resync replays a backlog it cannot consume quickly enough, the main thread
 * saturates again, and the watchdog reloads the window — straight back into the same backlog. The
 * reload is the *cause* of the next freeze, and after {@link MAX_RENDERER_RELOADS} the client stops
 * reloading and simply sits there accepting clicks that do nothing.
 *
 * ⚠️ **Why the existing watchdog could not see this.** It measures ONE window's responsiveness and
 * treats a reload as the remedy. It has no idea a stream is flooding, so it cannot tell "this window
 * is briefly busy" (reload is right) from "the thing being reloaded into is the problem" (reload is
 * exactly wrong, and repeating it is the loop). Both look identical from inside the watchdog: a
 * renderer that is not answering.
 *
 * This probe exists to supply the missing half — what the client was being *asked* to do — so the
 * decision between "wait" and "reload" stops being a guess. It is deliberately passive: it counts and
 * reports, and a policy consumes it. It never reloads anything itself.
 */

/** What one stream did, between two reports. Counters are monotonic within a connection. */
export interface EventPressureSample {
  /** Events the client accepted since the last report. The number that matters: it is the work. */
  readonly accepted: number
  /** Events the server told us it had buffered when it shed us. Zero on a healthy stream. */
  readonly bufferedAtOverflow: number
  /** Wall-clock ms this sample covers. */
  readonly windowMs: number
  /** Set when the server reported this client as too slow and cut the stream. */
  readonly overflowed: boolean
  /** Connection generation, so a resync is visible as a new number rather than a silent reset. */
  readonly generation: number
}

/**
 * The verdict, and the one number behind it.
 *
 * 🔴 **A sustained high rate is the load-bearing signal, and a single burst is not.** The overflow
 * proves the server's own view: it buffers 6,712 events and then cuts. But the client that caused it
 * may recover on its own, and reloading a window that is about to catch up destroys work for nothing.
 * What does not recover on its own is a rate that stays high for long enough that the backlog can
 * only grow — so the policy is expressed over a RATE and a DURATION, never over one sample.
 */
export type EventPressureVerdict =
  | { readonly kind: "healthy" }
  | { readonly kind: "brief-burst"; readonly ratePerSec: number }
  /** Sustained: the backlog is still growing. A reload makes this worse, so the verdict forbids one. */
  | { readonly kind: "sustained-flood"; readonly ratePerSec: number; readonly buffered: number }

/** Sustained rate that counts as a flood, in events per second. */
export const FLOOD_RATE_PER_SEC = 40
/** How long a flood must persist before it is called one, in ms. */
export const FLOOD_SUSTAIN_MS = 8_000

/**
 * Classify a pressure sample. Pure, so the policy is provable without Electron or a live server —
 * the same reason `renderer-watchdog-policy.ts` keeps its own arithmetic out of the watchdog.
 *
 * ⚠️ The overflow flag alone is NOT a flood. The server cuts a client for being briefly behind, and
 * that client may be fine a second later. Treating the cut as the verdict is what turns a hiccup
 * into a reload, and a reload into the loop above.
 */
export function classifyEventPressure(
  sample: EventPressureSample,
  policy?: { readonly ratePerSec?: number; readonly sustainMs?: number },
): EventPressureVerdict {
  const rateFloor = policy?.ratePerSec ?? FLOOD_RATE_PER_SEC
  const sustainMs = policy?.sustainMs ?? FLOOD_SUSTAIN_MS
  const rate = sample.windowMs > 0 ? (sample.accepted / sample.windowMs) * 1000 : 0
  if (rate < rateFloor) {
    // A cut with a low rate is a hiccup, not a flood: the client was briefly behind and is not
    // asking for more. Saying so is the whole point of having the other verdict.
    return sample.overflowed ? { kind: "brief-burst", ratePerSec: rate } : { kind: "healthy" }
  }
  // High rate AND long enough that the backlog can only grow. One high sample inside a short window
  // is a burst; the duration is what separates it.
  if (sample.windowMs >= sustainMs) {
    return { kind: "sustained-flood", ratePerSec: rate, buffered: sample.bufferedAtOverflow }
  }
  return { kind: "brief-burst", ratePerSec: rate }
}

/**
 * Rolling pressure for one client, fed by the stream and read by whatever decides how to recover.
 *
 * Deliberately not a singleton: a test needs its own, and a global would make two clients share a
 * verdict.
 */
export function createEventPressureProbe(input?: { readonly now?: () => number; readonly sustainMs?: number }) {
  const now = input?.now ?? Date.now
  let generation = 0
  let accepted = 0
  let bufferedAtOverflow = 0
  let overflowed = false
  let since = now()

  return {
    /** A new connection (or a resync): a fresh generation and a fresh rate window. */
    reconnected() {
      generation += 1
      accepted = 0
      overflowed = false
      since = now()
    },
    /** One event accepted by the client. This is the work that loads the main thread. */
    acceptedEvent() {
      accepted += 1
    },
    /**
     * The server cut us for falling behind. `buffered` is its count of what it was holding, which
     * is the only direct measure anyone has of how far behind we actually were.
     */
    overflowed(buffered: number) {
      overflowed = true
      bufferedAtOverflow = buffered
    },
    /** Read the current verdict. Does not reset the window, so repeated calls are consistent. */
    verdict(): EventPressureVerdict {
      return classifyEventPressure(
        {
          accepted,
          bufferedAtOverflow,
          windowMs: now() - since,
          overflowed,
          generation,
        },
        input?.sustainMs === undefined ? undefined : { sustainMs: input.sustainMs },
      )
    },
    /** The raw numbers, for a log line that lets a person check the verdict rather than trust it. */
    sample(): EventPressureSample {
      return { accepted, bufferedAtOverflow, windowMs: now() - since, overflowed, generation }
    },
    /** Drop the rate window without forgetting the generation — used after a healthy stretch. */
    resetWindow() {
      accepted = 0
      since = now()
    },
  }
}

export type EventPressureProbe = ReturnType<typeof createEventPressureProbe>
