/**
 * Notify when an existing DOM subtree containing `target` is removed and reinserted.
 *
 * Solid Suspense preserves resolved nodes by moving them through a staging fragment. Chromium keeps
 * the element objects but can discard native state such as nested scroll positions and Selection
 * ranges. Descendant observers cannot see that ancestor move, so state owners use this one seam.
 */
export function observeAncestorReattachment(target: Element, onReattach: () => void): () => void {
  const movedTarget = (node: Node) => node === target || node.contains(target)
  const observer = new MutationObserver((records) => {
    if (!target.isConnected) return
    const moved = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(movedTarget),
    )
    if (moved) onReattach()
  })

  // Observe containment edges only. Changes inside the target are owned by its component, while a
  // sibling/toast mutation must not look like a reattachment and restore native state spuriously.
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { childList: true })
  }
  return () => observer.disconnect()
}
