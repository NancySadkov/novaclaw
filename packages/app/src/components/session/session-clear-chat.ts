import { startChat } from "@/apps/agent-list"
import { rootsToClear, type SessionLike } from "@/apps/roster-live"
import { isSessionNotFoundError } from "@/utils/server-errors"

type ClearChatClient = {
  agent: { chats: (query: { agentID: string }) => Promise<unknown> }
} & Parameters<typeof startChat>[0] & {
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
/**
 * Every root chat this colleague has, straight from the instance.
 *
 * 🔴 This used to be `rootsToClear(await listSessions(client), …)`, and `listSessions` sends no limit,
 * so the instance returned the newest 50 sessions and the Clear acted on a PAGE of the colleague's
 * history. A colleague with more than that had a Clear that removed part of what it should have and
 * reported success — and a removal that reports success while leaving transcripts behind is worse than
 * one that fails, because the user is told the conversation is gone.
 *
 * `GET /api/agent/{agentID}/chats` returns every ROOT, archived included, which is both facts the
 * client could not have: the roots are already filtered server-side, and an archived root is present —
 * the transcript a user is reading is often a filed one, which is the recorded incident where clearing
 * said there was nothing to do while that transcript stayed put.
 *
 * The rows are shaped to what `rootsToClear` already reads, so its ordering rules and their tests stand
 * unchanged; only the SOURCE moved, and it now cannot be truncated.
 */
const everyOfficerChat = async (input: {
  client: { agent: { chats: (query: { agentID: string }) => Promise<unknown> } }
  agentID: string
}): Promise<readonly SessionLike[]> => {
  const response = (await input.client.agent.chats({ agentID: input.agentID })) as {
    data?: { data?: ReadonlyArray<{ id?: string; title?: string; directory?: string; archived?: number | null }> }
  }
  const rows = response?.data?.data
  // A 200 with no array is the instance contradicting its contract. Treating it as "no chats" would
  // report "nothing to clear" and leave every transcript in place, so it is a fault and it propagates.
  if (!Array.isArray(rows)) throw new Error(`the instance answered ${input.agentID}'s chats with no list`)
  return rows.flatMap((row) =>
    row.id
      ? [
          {
            id: row.id,
            agent: input.agentID,
            // Roots only — the server filtered, and re-deriving it here is the bug this replaced.
            parentID: undefined,
            location: row.directory ? { directory: row.directory } : undefined,
            time: { created: 0, updated: 0, archived: row.archived ?? undefined },
          } as unknown as SessionLike,
        ]
      : [],
  )
}

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
  const targets = rootsToClear(await everyOfficerChat(input), input.agentID, input.pathname)
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
