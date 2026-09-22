export const INBOUND_INBOX_CAPACITY = 256

export const makeInboundInbox = <A>(capacity: number, overflow: () => unknown) => {
  let buffer: A[] = []
  let waiter: { resolve: (batch: readonly A[]) => void; reject: (error: unknown) => void } | undefined
  let failure: unknown

  const fail = (error: unknown) => {
    failure ??= error
    const pending = waiter
    waiter = undefined
    pending?.reject(failure)
  }

  return {
    push: (value: A): void => {
      if (failure !== undefined) return
      if (buffer.length >= capacity) {
        fail(overflow())
        return
      }
      buffer.push(value)
      if (waiter === undefined) return
      const pending = waiter
      waiter = undefined
      const batch = buffer
      buffer = []
      pending.resolve(batch)
    },
    fail,
    pull: (): Promise<readonly A[]> =>
      new Promise((resolve, reject) => {
        if (buffer.length > 0) {
          const batch = buffer
          buffer = []
          resolve(batch)
          return
        }
        if (failure !== undefined) {
          reject(failure)
          return
        }
        waiter = { resolve, reject }
      }),
  }
}
