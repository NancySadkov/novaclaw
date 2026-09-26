import { base64Encode } from "@novaclaw/core/util/encode"
import { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

/**
 * The route for an AGENT — its current session is resolved through it, never named in the URL.
 *
 * 🔴 AGENTS.md: a session is a component on the agent entity. Addressing the agent is what makes
 * Clear Chat a change of COMPONENT (the route, the tab and any open dialog keep their identity)
 * instead of a change of place.
 */
export function agentHref(server: ServerConnection.Key, agentID: string) {
  return `/server/${base64Encode(server)}/agent/${agentID}`
}

export function legacySessionHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)
  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")
  return ServerConnection.Key.make(key)
}

export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
) {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  return matches.find((tab) => tab.server === active)?.server ?? (matches.length === 1 ? matches[0]?.server : active)
}

type SessionParent = { id: string; parentID?: string }

export function selectSessionLineage<T extends { session: { id: string } }>(
  sessionID: string,
  cached: T | undefined,
  resolved: T | undefined,
) {
  if (cached?.session.id === sessionID) return cached
  if (resolved?.session.id === sessionID) return resolved
}

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }
  return current
}
