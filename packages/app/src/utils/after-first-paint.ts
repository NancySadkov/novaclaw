/**
 * Run something once the first paint has landed — and run it EVEN WHEN THERE WILL NEVER BE ONE.
 *
 * 🔴 That second half is the whole point. `requestAnimationFrame` never fires in a hidden tab: a
 * background browser tab, a window restored minimized, a headless preview. Deferring work to a bare
 * rAF therefore means "do this when the user looks at the window", which is not what any caller
 * meant. `context/layout.tsx` did exactly that and never called `loadSessions` for any open project,
 * so a window opened in the background showed an empty chat list — indistinguishable from having no
 * chats, because the SSE stream (whose own copy of this logic had the guard) started normally.
 *
 * There were three spellings of this: the guarded one in `context/server-sync.tsx`, the unguarded
 * one in `context/layout.tsx`, and a promise with a 50 ms race in `context/global-sync/bootstrap.ts`.
 * This is the one, and the 50 ms race survives as `timeoutMs` because bootstrap genuinely must not
 * wait on a frame that a visible-but-not-painting window has not produced yet.
 *
 * Returns a cancel function; call it from `onCleanup`.
 */
export interface AfterFirstPaintOptions {
  /** Fire anyway after this many ms, even if the frame never arrives. Omitted = wait for it. */
  readonly timeoutMs?: number
}

export function afterFirstPaint(run: () => void, options?: AfterFirstPaintOptions): () => void {
  let done = false
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let cap: ReturnType<typeof setTimeout> | undefined

  const cancel = () => {
    done = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
    if (cap !== undefined) clearTimeout(cap)
    frame = undefined
    timer = undefined
    cap = undefined
  }

  const fire = () => {
    if (done) return
    cancel()
    run()
  }

  // One macrotask AFTER the frame callback, so the browser has actually committed the paint rather
  // than merely told us it is about to. Every one of the three original copies did this.
  const soon = () => {
    timer = setTimeout(fire, 0)
  }

  const paintable =
    typeof requestAnimationFrame === "function" &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible"

  if (!paintable) {
    soon()
    return cancel
  }

  if (options?.timeoutMs !== undefined) cap = setTimeout(fire, options.timeoutMs)
  frame = requestAnimationFrame(() => {
    frame = undefined
    soon()
  })
  return cancel
}
