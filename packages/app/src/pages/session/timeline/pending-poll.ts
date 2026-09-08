export interface PendingPollInput<A> {
  readonly repeat: boolean
  readonly fetch: () => Promise<readonly A[]>
  readonly update: (rows: readonly A[]) => void
  readonly every?: (tick: () => void) => () => void
}

/** Preserve Solid signal identity when a poll returns the same ordered rows. */
export function keepEqualRows<A>(current: readonly A[], next: readonly A[], same: (a: A, b: A) => boolean) {
  return current.length === next.length && current.every((item, index) => same(item, next[index]!)) ? current : next
}

/** One immediate read always; a repeating read only while work or a known queued row remains. */
export function startPendingPoll<A>(input: PendingPollInput<A>): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const rows = await input.fetch()
    if (!stopped) input.update(rows)
  }
  void tick()
  const cancel = input.repeat
    ? (
        input.every ??
        ((next) => {
          const timer = setInterval(next, 2000)
          return () => clearInterval(timer)
        })
      )(() => void tick())
    : undefined
  return () => {
    stopped = true
    cancel?.()
  }
}
