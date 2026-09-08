/**
 * **A WRITE THAT CANNOT REPORT SUCCESS WHEN IT FAILED.**
 *
 * 🔴 Ruling 2's first half — *a failed mutation never reports success* — and the shape that kept
 * breaking it is not a missing `catch`. It is a *present* one:
 *
 * ```ts
 * async function persist(next: T) {
 *   await sync().updateConfig({ key: next }).catch(showTheToast)   // swallows, then RESOLVES
 * }
 * await persist(next)
 * closeTheEditor()                                                 // runs whether or not it landed
 * ```
 *
 * The helper turns a rejected promise into a resolved one, so `await persist(…)` carries no verdict
 * at all and every statement after it is a claim the write landed. That is the wrapper class
 * AGENTS.md names: *a wrapper whose caller must remember a step the wrapper is supposed to own.*
 * Three panels wrote it and each lost something a person had typed — a tool manual, a pasted peer
 * token, a switch position reported only to a console nobody has open.
 *
 * So the verdict is a VALUE here, and `ok` is the only way to get one. The success-only work goes
 * behind a check the type puts in front of it:
 *
 * ```ts
 * const saved = await persist(next)
 * if (!saved.ok) return
 * closeTheEditor()
 * ```
 *
 * ⚠️ **The report is a PARAMETER, not a toast.** This module owns the verdict; the panel owns the
 * voice. That is what keeps it importable from a plain unit test, and it is also why a panel can
 * put the sentence where the failure happened — beside the editor that is still holding the draft —
 * rather than only in a toast that scrolls away.
 */

/** What a write did. `ok` is the only spelling of "it landed". */
export type ConfigWrite = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** The server's own sentence, or the value's, for anything that reaches a person. */
export const writeMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Run one write, report a rejection, and hand back the verdict.
 *
 * @param write the mutation, as a thunk — the call site keeps its own arguments and options.
 * @param report called EXACTLY once on failure, with the message a person should read.
 */
export async function reportedWrite(
  write: () => Promise<unknown>,
  report: (error: string) => void,
): Promise<ConfigWrite> {
  try {
    await write()
    return { ok: true }
  } catch (error) {
    const message = writeMessage(error)
    report(message)
    return { ok: false, error: message }
  }
}
