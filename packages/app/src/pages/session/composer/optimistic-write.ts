/**
 * Apply a control's value immediately, and put it back if the server refuses.
 *
 * 🔴 **NC-REL-035 — an optimistic write that FAILED stayed on screen.** Every switch in the composer
 * wrote its value into persisted browser state FIRST, fired the server request, and handled failure
 * with `console.error` alone. So a refused write left the UI showing one posture while the kernel
 * kept the other — and for the permission mode and the Strict switch that is a SAFETY posture: the
 * composer says "plan" while the session still runs under the old permissions, and nothing anywhere
 * says otherwise.
 *
 * ⚠️ Revert AND report. Reverting silently is its own lie — the control appears to spring back for no
 * reason — and the standing rule here is that a failed mutation never reports success.
 *
 * ⚠️ Its own module so the ORDER is testable: applied before the write, put back only on rejection,
 * never touched again on success. Inside the controls factory it would need a server, a session view
 * and a live sync store to reach.
 */
export type OptimisticWrite<T> = {
  /** Writes the control's value — the same setter the UI reads. */
  readonly set: (value: T) => void
  /** What it was, captured BEFORE the optimistic set. */
  readonly previous: T
  readonly next: T
  readonly write: Promise<unknown>
  /** Told only when the value was put back, so the reason can name the control. */
  readonly onReverted: (error: unknown) => void
}

export async function applyOptimistic<T>(input: OptimisticWrite<T>): Promise<{ readonly reverted: boolean }> {
  input.set(input.next)
  try {
    await input.write
    return { reverted: false }
  } catch (error) {
    input.set(input.previous)
    input.onReverted(error)
    return { reverted: true }
  }
}
