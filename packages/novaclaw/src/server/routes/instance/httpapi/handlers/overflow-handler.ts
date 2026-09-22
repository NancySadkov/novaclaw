import { Effect, Queue } from "effect"

export function createOverflowTerminatingHandler<T>(
  queue: Queue.Enqueue<T, never>,
  offer: (event: T) => boolean,
  onOverflow: () => void,
) {
  let overflowed = false
  return (event: T) => {
    if (overflowed) return
    if (offer(event)) return
    overflowed = true
    Effect.runSync(Queue.shutdown(queue))
    onOverflow()
  }
}
