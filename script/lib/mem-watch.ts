/**
 * The live half of the memory kill: poll the peak sampler while a unit runs and fire once its
 * own tree crosses the cap.
 *
 * Kept in `lib` rather than inline in `test.ts` so the loop is testable without spawning
 * anything: the sampler is a `() => number | undefined`, the breach action is a callback, and
 * time is an injected sleeper. `test.ts` wires the real sampler, the real `killTree`, and
 * `Bun.sleep`.
 */

export interface MemWatch {
  /** Resolves when the loop exits — by breach or by `settle()`. Never rejects. */
  readonly finished: Promise<void>
  /** The breach peak in MB, once fired. */
  readonly peakMb: number | undefined
  /** Stop watching; the loop exits without firing. Idempotent. */
  readonly settle: () => void
}

export function watchMemoryKill(input: {
  sample: () => number | undefined
  capMb: number
  onBreach: (peakMb: number) => void
  sleepMs: (ms: number) => Promise<void>
  intervalMs: number
}): MemWatch {
  let settled = false
  let peak: number | undefined
  let resolveFinished: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })
  void (async () => {
    try {
      for (;;) {
        await input.sleepMs(input.intervalMs)
        if (settled) return
        const tree = input.sample()
        if (tree !== undefined && tree >= input.capMb) {
          peak = tree
          settled = true
          input.onBreach(tree)
          return
        }
      }
    } catch {
      // A watch that dies noisily is worse than no watch: the unit would run uncapped AND red.
      // The sampler never throws by contract, and the sleep is the harness's own — but if either
      // ever does, the unit runs on bare, exactly as it did before this file existed.
    } finally {
      resolveFinished()
    }
  })()
  return {
    finished,
    get peakMb() {
      return peak
    },
    settle: () => {
      settled = true
    },
  }
}
