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
  wait: (ms: number) => Promise<void>
  delay: (failure: number) => number
  state: (status: ReconnectStreamState, attempt: number) => void
  attemptStarted?: (attempt: AbortController) => void
  attemptFinished?: (attempt: AbortController) => void
  failed?: (error: unknown, signal: AbortSignal) => void
  now?: () => number
}

/**
 * Keep one event stream alive until its owner stops it. A connection becomes usable only after its
 * recovery barrier settles; every failure publishes a one-based attempt before the bounded wait.
 */
export async function runReconnectingStream<T>(options: ReconnectStreamOptions<T>) {
  let failures = 0
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
    await options.wait(options.delay(failures++))
  }
}
