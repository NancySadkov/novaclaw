import { listSessions, startChat } from "@/apps/agent-list"
import { rootsToClear } from "@/apps/roster-live"

type ClearChatClient = Parameters<typeof listSessions>[0] &
  Parameters<typeof startChat>[0] & {
    session: { remove: (input: { sessionID: string }) => Promise<{ error?: unknown }> }
  }

export async function clearOfficerChat(input: {
  client: ClearChatClient
  agentID: string
  name: string
  pathname: string
  onReplacementFailed: (sessionIDs: string[]) => void
}) {
  const targets = rootsToClear(await listSessions(input.client), input.agentID, input.pathname)
  if (targets.length === 0) return undefined
  for (const target of targets) {
    const removed = await input.client.session.remove({ sessionID: target.id })
    if (removed.error) throw removed.error
  }
  try {
    const successor = await startChat(input.client, { agentID: input.agentID, title: input.name })
    if (successor === undefined) throw new Error("The replacement chat could not be opened. Open the officer to retry.")
    return successor
  } catch (error) {
    input.onReplacementFailed(targets.map((target) => target.id))
    throw error
  }
}
