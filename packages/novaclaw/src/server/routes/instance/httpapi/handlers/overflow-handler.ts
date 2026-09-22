export function createOverflowTerminatingHandler<T>(offer: (event: T) => boolean, onOverflow: () => void) {
  let overflowed = false
  return (event: T) => {
    if (overflowed) return
    if (offer(event)) return
    overflowed = true
    onOverflow()
  }
}
