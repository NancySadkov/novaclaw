import { Queue } from "effect"

export const INBOUND_QUEUE_CAPACITY = 256

export const makeBoundedInboundQueue = <A, E = never>(capacity = INBOUND_QUEUE_CAPACITY) =>
  Queue.bounded<A, E>(capacity)

export const createOverflowTerminatingHandler = <A>(offer: (value: A) => boolean, onOverflow: () => void) => {
  let overflowed = false
  return (value: A) => {
    if (overflowed) return
    if (offer(value)) return
    overflowed = true
    onOverflow()
  }
}
