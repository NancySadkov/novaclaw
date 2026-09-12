export type OrderedModelKey = { provider: { id: string }; id: string }

export const modelOrderRef = (model: OrderedModelKey) => `${model.provider.id}/${model.id}`

/**
 * Apply a sparse saved arrangement to the live catalog.
 *
 * Saved refs which disappeared are ignored; live models the arrangement has never seen append in
 * their natural order. That makes provider refresh/add/remove safe without rewriting the setting.
 */
export function applyModelOrder<T extends OrderedModelKey>(items: readonly T[], saved: readonly string[]): T[] {
  const byRef = new Map(items.map((item) => [modelOrderRef(item), item]))
  const ordered: T[] = []
  for (const ref of saved) {
    const item = byRef.get(ref)
    if (!item) continue
    ordered.push(item)
    byRef.delete(ref)
  }
  for (const item of items) if (byRef.has(modelOrderRef(item))) ordered.push(item)
  return ordered
}

/** Move one live ref onto another and return the complete arrangement written to SQLite. */
export function moveModelOrder(items: readonly string[], fromRef: string, toRef: string): string[] | undefined {
  if (fromRef === toRef) return
  const next = [...items]
  const from = next.indexOf(fromRef)
  const to = next.indexOf(toRef)
  if (from < 0 || to < 0) return
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
