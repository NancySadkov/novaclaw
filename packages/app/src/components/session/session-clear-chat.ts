import { listSessions, startChat } from "@/apps/agent-list"
import { rootsToClear } from "@/apps/roster-live"

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
}): Promise<{ readonly successor: string; readonly removed: readonly string[] } | undefined> {
  const targets = rootsToClear(await listSessions(input.client), input.agentID, input.pathname)
  if (targets.length === 0) return undefined
  const removed: string[] = []
  for (const target of targets) {
    const result = await input.client.session.remove({ sessionID: target.id })
    if (result.error) throw result.error
    removed.push(target.id)
  }
  try {
    const successor = await startChat(input.client, { agentID: input.agentID, title: input.name })
    if (successor === undefined) throw new Error("The replacement chat could not be opened. Open the officer to retry.")
    return { successor, removed }
  } catch (error) {
    input.onReplacementFailed(removed)
    throw error
  }
}
