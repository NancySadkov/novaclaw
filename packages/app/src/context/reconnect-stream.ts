export type ReconnectStreamState = "connected" | "reconnecting"

export interface ReconnectStreamOptions<T> {
  active: () => boolean
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>
  recover: () => Promise<void>
  accept: (event: T) => void | Promise<void>
  wait: (ms: number) => Promise<void>
  delay: (failure: number) => number
  state: (status: ReconnectStreamState, attempt: number) => void
  attemptStarted?: (attempt: AbortController) => void
  attemptFinished?: (attempt: AbortController) => void
  failed?: (error: unknown, signal: AbortSignal) => void
}

/**
 * Keep one event stream alive until its owner stops it. A connection becomes usable only after its
 * recovery barrier settles; every failure publishes a one-based attempt before the bounded wait.
 */
export async function runReconnectingStream<T>(options: ReconnectStreamOptions<T>) {
  let failures = 0

  while (options.active()) {
    const attempt = new AbortController()
    options.attemptStarted?.(attempt)
    try {
      const stream = await options.open(attempt.signal)
      let received = false
      for await (const event of stream) {
        if (!received) {
          received = true
          await options.recover()
          if (!options.active() || attempt.signal.aborted) return
          failures = 0
          options.state("connected", 0)
        }
        await options.accept(event)
      }
    } catch (error) {
      options.failed?.(error, attempt.signal)
    } finally {
      options.attemptFinished?.(attempt)
    }

    if (!options.active()) return
    const displayAttempt = failures + 1
    options.state("reconnecting", displayAttempt)
    await options.wait(options.delay(failures++))
  }
}
