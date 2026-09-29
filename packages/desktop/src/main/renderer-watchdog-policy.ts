/**
 * 🔴 WHAT TO DO ABOUT A RENDERER THAT STOPPED RESPONDING.
 *
 * Measured 2026-09-29 on a live client against a server that was provably healthy — `/global/health`
 * answered 200 in 13 ms. The renderer froze mid-session and never recovered: the window stopped
 * painting entirely (the tab activity indicators stopped pulsing, which is a renderer no longer
 * producing frames), the server logged no client connection for the duration, and the client's own
 * network service sat on six sockets that had been `Established` for 366 s and would never carry a
 * request again. The reconnect counter climbed locally while nothing reached the network.
 *
 * **A fault detector with no remedy attached is a post-mortem, not a recovery path.** The old
 * `unresponsive.ts` was exactly that: it sampled JavaScript stacks for 15 s, logged them, and returned.
 * The user-visible response was a dialog offering to relaunch the app, open the logs, or keep waiting —
 * three manual escapes, in a product whose own rule is that it heals itself. The sidecar already had
 * the opposite shape (`server.ts`: "sidecar missed N health checks — terminating the hung process"); the
 * renderer had none.
 *
 * The remedy is cheap because a renderer is the ONE component that holds nothing. Every durable thing
 * belongs to the server, so a window that cannot paint can simply be rebuilt — which is also the only
 * thing that unwedges the renderer's main thread, drops the sockets its network service is holding, and
 * re-establishes the event stream. There is no state a reload can lose.
 *
 * ⚠️ **Its own module, importing nothing.** This is the policy and it is pure, so it is testable
 * without Electron — and that is not a style preference. `unresponsive.ts` imports `./logging`, which
 * imports `electron`, whose package main export is a path STRING; under `bun test` any real value
 * import from it throws `Export named 'netLog' not found`. The policy therefore cannot live in the same
 * file as the logging, or the one piece of this that must be provable becomes the piece that cannot be
 * loaded. Kept here, it is provable by simply calling it.
 */
export type RendererRecovery =
  /** Still inside the grace period, or it came back on its own. Do nothing. */
  | { readonly kind: "wait" }
  /** Rebuild the window: it holds nothing, and this is the only thing that unwedges a renderer. */
  | { readonly kind: "reload"; readonly attempt: number }
  /** It keeps wedging. Stop, and tell the person what happened instead of looping forever. */
  | { readonly kind: "give-up"; readonly attempt: number }

/**
 * How long a renderer may stay unresponsive before we touch it.
 *
 * ⚠️ Not zero, and that is the whole subtlety. Electron raises `unresponsive` for a window that merely
 * has not answered its message pump for a few seconds, which a long GC or a big synchronous render
 * does while still finishing correctly. Reloading on the event itself would destroy a window that was
 * about to be fine — trading a pause the user can see for a reload they cannot. The same bound the
 * preload watchdog uses for a bridge that never arrives, applied to a frame that never settles.
 */
export const RENDERER_GRACE_MS = 10_000

/**
 * How many recovery reloads before we stop.
 *
 * 🔴 Bounded on purpose. A reload always "works" in the sense that a fresh renderer is not wedged, so
 * an unbounded watchdog turns a deterministic hang into an infinite reload loop: the window flickers
 * forever, the user cannot read a single frame, and the failure is strictly harder to diagnose than
 * the freeze it replaced. Two attempts is enough to clear a one-off wedge and to prove a reproducible
 * one; past that the honest move is to stop and report.
 */
export const MAX_RENDERER_RELOADS = 2

/** The policy, as a pure function, so it can be asserted without an Electron window or a real clock. */
export function rendererRecovery(input: {
  readonly unresponsiveForMs: number
  readonly reloadsSoFar: number
  readonly graceMs?: number
  readonly maxReloads?: number
}): RendererRecovery {
  const grace = input.graceMs ?? RENDERER_GRACE_MS
  const max = input.maxReloads ?? MAX_RENDERER_RELOADS
  if (input.unresponsiveForMs < grace) return { kind: "wait" }
  // Reported one-based: "this is reload 2 of 2" is a sentence a person can act on.
  const attempt = input.reloadsSoFar + 1
  return input.reloadsSoFar < max ? { kind: "reload", attempt } : { kind: "give-up", attempt }
}
