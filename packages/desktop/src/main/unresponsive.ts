import { write as writeLog } from "./logging"

const sampleInterval = 1000
const samplePeriod = 15000

/**
 * The slice of `BrowserWindow` the sampler drives.
 *
 * ⚠️ Declared here rather than imported from `electron`, and that is load-bearing for the tests: the
 * `electron` package's main export is a path string, so `import ... from "electron"` throws at runtime
 * under `bun test` ("Export named 'netLog' not found"). A TYPE import is erased and was always safe,
 * but the moment this module needed a real value from electron it stopped being testable at all — so
 * the shape is declared locally and the real `BrowserWindow` is passed to it structurally.
 */
export interface SampledWindow {
  isDestroyed(): boolean
  /**
   * ⚠️ `BrowserWindow` is an EventEmitter whose `on` is the WIDE `(event: string | symbol, listener:
   * (...args: any[]) => void)` overload. Narrowing it to one literal name would make a real
   * `BrowserWindow` structurally UNASSIGNABLE to this interface, which is the opposite of the point —
   * the whole reason the shape is declared locally is that the real window satisfies it.
   */
  on(event: string, listener: (...args: any[]) => void): unknown
  webContents: {
    isDestroyed(): boolean
    isDevToolsOpened(): boolean
    getURL(): string
    /**
     * ⚠️ `collectJavaScriptCallStack(): Promise<string> | Promise<void>` in Electron's own types — the
     * `void` arm is what a frame that is gone returns. Declaring the narrower
     * `Promise<string | undefined>` made a real `BrowserWindow` unassignable here, which is how this
     * mistake was caught: the shape exists to be satisfied BY the real window, so it must be no
     * stricter than the real window.
     */
    mainFrame: { collectJavaScriptCallStack(): Promise<string> | Promise<void> }
  }
}

export { rendererRecovery, RENDERER_GRACE_MS, MAX_RENDERER_RELOADS, type RendererRecovery } from "./renderer-watchdog-policy"

export function createUnresponsiveSampler(win: SampledWindow, name: string) {
  let sampleTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let sampling = false
  const samples = new Map<string, number>()

  const active = () => sampling && !win.isDestroyed() && !win.webContents.isDestroyed()
  const clearTimers = () => {
    if (sampleTimer) clearTimeout(sampleTimer)
    if (stopTimer) clearTimeout(stopTimer)
    sampleTimer = undefined
    stopTimer = undefined
  }

  const schedule = () => {
    sampleTimer = setTimeout(() => {
      void collect()
    }, sampleInterval)
  }

  const collect = async () => {
    if (!active()) return
    const stack = await win.webContents.mainFrame.collectJavaScriptCallStack().catch((error) => {
      writeLog("window", "failed to collect unresponsive sample", { window: name, error }, "error")
      return undefined
    })
    if (!active()) return
    if (stack) samples.set(stack, (samples.get(stack) ?? 0) + 1)
    schedule()
  }

  const stopAndFlush = () => {
    const wasSampling = sampling
    sampling = false
    clearTimers()
    if (samples.size === 0) return wasSampling

    const entries = [...samples.entries()].sort((a, b) => b[1] - a[1])
    const total = entries.reduce((sum, entry) => sum + entry[1], 0)
    const message = [
      "renderer unresponsive samples",
      `Window: ${name}`,
      `URL: ${win.isDestroyed() ? "<destroyed>" : win.webContents.getURL()}`,
      ...entries.map((entry) => `<${entry[1]}> ${entry[0]}`),
      `Total Samples: ${total}`,
    ].join("\n")
    writeLog("window", message, undefined, "error")
    samples.clear()
    return wasSampling
  }

  const start = () => {
    if (sampling || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isDevToolsOpened()) return
    sampling = true
    samples.clear()
    schedule()
    stopTimer = setTimeout(stopAndFlush, samplePeriod)
  }

  win.on("closed", stopAndFlush)

  return { start, stopAndFlush }
}
