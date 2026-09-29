import { rendererRecovery, RENDERER_GRACE_MS, MAX_RENDERER_RELOADS } from "./renderer-watchdog-policy"

export type { RendererRecovery } from "./renderer-watchdog-policy"

/** The slice of `BrowserWindow` the watchdog drives, so a test can hand it a fake. */
export interface RendererWindow {
  isDestroyed(): boolean
  reload(): void
  webContents: { isDestroyed(): boolean; isDevToolsOpened(): boolean }
}

/**
 * Recovers a wedged renderer instead of photographing one.
 *
 * ⚠️ **Every exit is bounded and every exit is honest.** The watchdog arms on `unresponsive`, waits out
 * {@link RENDERER_GRACE_MS} for a slow frame to finish on its own, and reloads if the window is still
 * dead. It disarms the instant the window becomes `responsive`, so it never yanks a window that
 * recovered. After {@link MAX_RENDERER_RELOADS} it stops reloading and reports, because a reload loop
 * is a worse failure than the freeze it was built to end.
 *
 * ⚠️ **A reload is safe here precisely because a window is stateless.** Everything durable lives in the
 * server; the renderer holds a view. That is what makes recovery the right verb here, and it is why a
 * client that cannot paint is a bug rather than a lost session. The full measurement, and why the
 * remedy is a rebuild at all, is in `renderer-watchdog-policy.ts` — which is also where the policy
 * lives, separately, so it can be proven without Electron in the picture.
 */
export function createRendererWatchdog(
  win: RendererWindow,
  input: {
    readonly onRecovered: (attempt: number) => void
    readonly onGivenUp: (attempt: number) => void
    readonly graceMs?: number
    readonly maxReloads?: number
  },
) {
  let reloads = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let downSince: number | undefined

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const act = () => {
    timer = undefined
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    // DevTools open means a person is already looking at the renderer; reloading under them would
    // throw away the state they are inspecting. The same condition the sampler already honours.
    if (win.webContents.isDevToolsOpened()) return
    const decision = rendererRecovery({
      unresponsiveForMs: Date.now() - (downSince ?? Date.now()),
      reloadsSoFar: reloads,
      ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
      ...(input.maxReloads === undefined ? {} : { maxReloads: input.maxReloads }),
    })
    if (decision.kind === "wait") return
    if (decision.kind === "reload") {
      reloads = decision.attempt
      downSince = undefined
      clearTimer()
      input.onRecovered(decision.attempt)
      win.reload()
      return
    }
    downSince = undefined
    clearTimer()
    input.onGivenUp(decision.attempt)
  }

  const arm = () => {
    if (downSince !== undefined || win.isDestroyed()) return
    downSince = Date.now()
    clearTimer()
    timer = setTimeout(act, input.graceMs ?? RENDERER_GRACE_MS)
  }

  const disarm = () => {
    downSince = undefined
    clearTimer()
  }

  return { arm, disarm, reloadsSoFar: () => reloads }
}
