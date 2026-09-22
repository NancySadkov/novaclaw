export const makeBoundedMap = <K, V>(capacity: number) => {
  const limit = Math.max(1, Math.floor(capacity))
  const values = new Map<K, V>()
  return {
    get size() {
      return values.size
    },
    get: (key: K) => values.get(key),
    has: (key: K) => values.has(key),
    set: (key: K, value: V): void => {
      if (!values.has(key) && values.size >= limit) {
        const oldest = values.keys().next().value
        if (oldest !== undefined) values.delete(oldest)
      }
      values.set(key, value)
    },
    keys: () => values.keys(),
    values: () => values.values(),
    entries: () => values.entries(),
    [Symbol.iterator]: () => values[Symbol.iterator](),
  }
}
