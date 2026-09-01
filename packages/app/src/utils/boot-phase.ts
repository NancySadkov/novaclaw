/**
 * Report a startup phase that only the renderer can observe.
 *
 * The packaged desktop path must be measured through *renderer interactive* and
 * *first chat token*. The main process cannot see either — one is a paint, the other is a token
 * arriving over a websocket — so the renderer has to say.
 *
 * ⚠️ An INJECTED reporter rather than a direct `window.api` call, because this module is shared with
 * the web build, where no such bridge exists. `packages/desktop/src/renderer` installs the real one;
 * everywhere else this stays a no-op and the timeline reports the phase as MISSING, which is the
 * honest answer for a build that has no boot timeline at all.
 */

export type RendererBootPhase = "renderer-interactive" | "first-chat-token"

type Reporter = (phase: RendererBootPhase) => void

let reporter: Reporter | undefined

/** Install the platform's reporter. Called once, by the desktop renderer's entry. */
export function setBootPhaseReporter(next: Reporter | undefined) {
  reporter = next
}

/**
 * Report a phase. Never throws and never awaits.
 *
 * 🔴 Instrumentation may not be able to break the thing it measures. A boot that fails because its
 * own timeline threw would be the most embarrassing possible outcome for a file whose entire purpose
 * is diagnosing slow starts — so the call is wrapped, and a broken reporter costs a missing mark.
 */
export function reportBootPhase(phase: RendererBootPhase) {
  if (!reporter) return
  try {
    reporter(phase)
  } catch {
    /* a missing mark is reported as missing; a thrown one would be a defect we caused */
  }
}
