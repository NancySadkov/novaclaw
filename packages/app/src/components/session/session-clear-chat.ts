import { listSessions, startChat } from "@/apps/agent-list"
import { rootsToClear } from "@/apps/roster-live"
import { isSessionNotFoundError } from "@/utils/server-errors"

type ClearChatClient = Parameters<typeof listSessions>[0] &
  Parameters<typeof startChat>[0] & {
    session: { remove: (input: { sessionID: string }) => Promise<{ error?: unknown }> }
  }

/**
 * Remove every chat a Clear must take, then open the colleague's replacement.
 *
 * ⚠️ **The removed ids are RETURNED, and that is load-bearing.** The caller must retire each one
 * client-side (drop the cached record and close its tab) rather than relying on the asynchronous
 * `session.deleted` event: a Clear that ran without the event observed — the event stream was down,
 * or the sidecar restarted under a long-lived renderer — left the tab pointing at a destroyed id and
 * every send answered `Session not found: <id>` (owner, 2026-09-22). The ids are what makes the
 * retirement deterministic instead of eventual.
 */
export async function clearOfficerChat(input: {
  client: ClearChatClient
  agentID: string
  name: string
  pathname: string
  onReplacementFailed: (sessionIDs: string[]) => void
}): Promise<
  | { readonly successor: string; readonly removed: readonly string[]; readonly alreadyGone: readonly string[] }
  | undefined
> {
  const targets = rootsToClear(await listSessions(input.client), input.agentID, input.pathname)
  if (targets.length === 0) return undefined
  const removed: string[] = []
  const alreadyGone: string[] = []
  for (const target of targets) {
    const result = await input.client.session.remove({ sessionID: target.id })
    if (result.error) {
      /**
       * 🔴 **A CHAT THAT IS ALREADY GONE IS NOT A FAILURE — IT IS THE POINT.**
       *
       * Owner, 2026-09-26: Clear chat on Nova reported *"Could not clear this chat: Session not found:
       * ses_nova"* and dropped the connection. The removal had in fact happened: the list this loop
       * walks is read once, up front, so a retried or resumed Clear carries ids the first attempt
       * already deleted, and the second pass answered "not found" for work that was done. The user was
       * told a clear failed when it had succeeded.
       *
       * ⚠️ The check is on the ERROR'S OWN KIND, not on its text: only a not-found is treated as
       * already-gone, and every other fault still propagates, because a clear that half-failed must
       * still say so. Such an id is added to `removed` — the caller's job is to retire the traces of
       * chats that are gone, and this one is.
       */
      if (isSessionNotFoundError(result.error, target.id)) {
        alreadyGone.push(target.id)
        removed.push(target.id)
        continue
      }
      throw result.error
    }
    removed.push(target.id)
  }
  try {
    const successor = await startChat(input.client, { agentID: input.agentID, title: input.name })
    if (successor === undefined) throw new Error("The replacement chat could not be opened. Open the officer to retry.")
    return { successor, removed, alreadyGone }
  } catch (error) {
    input.onReplacementFailed(removed)
    throw error
  }
}
