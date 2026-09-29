export type ReconnectStreamState = "connected" | "reconnecting"

const STABLE_STREAM_MS = 30_000

/** Page suspension must release backoff before a visible page can start its fresh attempt. */
export function waitForStreamRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export interface ReconnectStreamOptions<T> {
  active: () => boolean
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>
  recover: (signal: AbortSignal) => Promise<void>
  accept: (event: T) => void | Promise<void>
  wait: (ms: number, signal?: AbortSignal) => Promise<void>
  delay: (failure: number) => number
  state: (status: ReconnectStreamState, attempt: number) => void
  attemptStarted?: (attempt: AbortController) => void
  attemptFinished?: (attempt: AbortController) => void
  failed?: (error: unknown, signal: AbortSignal) => void
  now?: () => number
  /**
   * A signal saying the failures counted so far are STALE, so the next wait is abandoned and the
   * count starts again from zero.
   *
   * 🔴 **Why the loop needs to be told, rather than simply given a shorter delay.** The instance
   * finished starting, which means every failure so far was earned against a port that was not bound
   * — not against a server that refused us. Carrying that count forward hands the first genuine
   * outage after a slow boot a 30 s delay it has not earned. Only the shell knows the difference
   * between "not up yet" and "up and refusing", so only the shell may spend the count; a shorter
   * delay cannot express it, because the delay has no memory and the count is the memory.
   *
   * ⚠️ `undefined` means "no opinion" and leaves the ladder completely untouched — which is what a
   * client with no supervisor, and a client watching an instance that is simply down, must get.
   */
  retryNow?: () => AbortSignal | undefined
}

/**
 * Wait out the backoff, unless the world says the wait itself is stale.
 *
 * @returns whether the wait was cut short, i.e. whether the caller must reset its failure count.
 */
async function waitUnlessStale(
  delayMs: number,
  stale: AbortSignal | undefined,
  wait: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  if (stale === undefined) {
    await wait(delayMs)
    return false
  }
  const release = new AbortController()
  const cut = () => release.abort()
  if (stale.aborted) cut()
  else stale.addEventListener("abort", cut, { once: true })
  try {
    await wait(delayMs, release.signal)
  } finally {
    stale.removeEventListener("abort", cut)
  }
  return stale.aborted
}

/**
 * Keep one event stream alive until its owner stops it. A connection becomes usable only after its
 * recovery barrier settles; every failure publishes a one-based attempt before the bounded wait.
 */
export async function runReconnectingStream<T>(options: ReconnectStreamOptions<T>) {
  let failures = 0
  let spentWindow: AbortSignal | undefined
  const now = options.now ?? Date.now

  while (options.active()) {
    const attempt = new AbortController()
    options.attemptStarted?.(attempt)
    let establishedAt: number | undefined
    try {
      const stream = await options.open(attempt.signal)
      let received = false
      for await (const event of stream) {
        if (!options.active()) return
        attempt.signal.throwIfAborted()
        if (!received) {
          received = true
          await options.recover(attempt.signal)
          if (!options.active()) return
          // A deadline ends this attempt, not its owner. Retry it through the same failure path as
          // a dropped socket; returning here permanently stranded a still-started connection.
          attempt.signal.throwIfAborted()
          establishedAt = now()
          options.state("connected", 0)
        }
        await options.accept(event)
      }
    } catch (error) {
      options.failed?.(error, attempt.signal)
    } finally {
      attempt.abort()
      options.attemptFinished?.(attempt)
    }

    if (!options.active()) return
    if (establishedAt !== undefined && now() - establishedAt >= STABLE_STREAM_MS) failures = 0
    const displayAttempt = failures + 1
    options.state("reconnecting", displayAttempt)
    const delayMs = options.delay(failures++)
    /**
     * A window is SPENT once it has been honoured, and spent exactly once.
     *
     * ⚠️ Without this the loop would consult an already-aborted signal on every subsequent wait, cut
     * each one short, and retry flat out for the life of the page — turning a fix for a 29-second wait
     * into the four-hertz reconnect storm the ladder exists to prevent. Identity is the test rather
     * than a boolean because a LATER start is a genuinely new signal, and must be honoured too.
     */
    const offered = options.retryNow?.()
    const stale = offered === undefined || offered === spentWindow ? undefined : offered
    if (await waitUnlessStale(delayMs, stale, options.wait)) {
      failures = 0
      spentWindow = stale
    }
  }
}
