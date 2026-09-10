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

/**
 * Transfer pending rows to the transcript without a frame in which neither projection owns them.
 *
 * The pending endpoint stops returning a row as soon as the runner promotes it. Its durable
 * `prompted` event can reach this browser later (or be missed across an SSE reconnect), so replacing
 * the pending list with the endpoint's empty result made an acknowledged message disappear. Retain
 * an absent pending row until the canonical transcript id is present. Inputs are append-only: there
 * is no legitimate server transition from pending to nowhere.
 */
export function handoffPending<A extends { readonly id: string }>(
  current: readonly A[],
  next: readonly A[],
  transcript: readonly { readonly id: string }[],
): readonly A[] {
  const canonical = new Set(transcript.map((message) => message.id))
  const byID = new Map(next.map((row) => [row.id, row] as const))
  for (const row of current) if (!canonical.has(row.id) && !byID.has(row.id)) byID.set(row.id, row)
  return [...byID.values()]
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
