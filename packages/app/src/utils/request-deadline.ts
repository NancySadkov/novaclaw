export const SESSION_REQUEST_TIMEOUT_MS = 30_000

export class RequestDeadlineError extends Error {
  override readonly name = "TimeoutError"

  constructor(label: string, timeoutMs: number) {
    super(
      `${label} timed out after ${Math.ceil(timeoutMs / 1_000)} seconds. Check the instance connection and try again.`,
    )
  }
}

/**
 * Give an instance request a real wall-clock deadline.
 *
 * Aborting the transport is not sufficient: a custom desktop fetch or stale SDK adapter may ignore
 * its signal. Racing the request guarantees the UI settles, while the abort still releases a normal
 * fetch immediately. Promise.race attaches a rejection handler to the losing request, so a later
 * transport failure cannot become an unhandled rejection.
 */
export async function withRequestDeadline<T>(input: {
  readonly label: string
  readonly run: (signal: AbortSignal) => Promise<T>
  readonly timeoutMs?: number
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RequestDeadlineError(input.label, timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([input.run(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
