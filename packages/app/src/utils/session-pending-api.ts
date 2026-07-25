import type { ServerConnection } from "@/context/server"
import { headersFor } from "./fs-api"

// Prompts the user has SENT but the agent has not read yet.
//
// A prompt submitted mid-turn is admitted durably and answered later, but it is not a transcript message
// until the runner promotes it — so without this it simply vanishes from the UI and reappears, answered,
// minutes later. Read from the server rather than rendered optimistically from our own submit, so a prompt
// sent from another device or the messenger gateway shows up here too.

export interface PendingPrompt {
  id: string
  text: string
  delivery: string
  timeCreated: number
}

export async function fetchPendingPrompts(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string },
): Promise<PendingPrompt[]> {
  const url = new URL(
    `api/session/${input.sessionID}/pending`,
    server.url.endsWith("/") ? server.url : `${server.url}/`,
  )
  const res = await fetch(url, {
    headers: { ...headersFor(server), "x-novaclaw-directory": input.directory },
  })
  if (!res.ok) return []
  const body = (await res.json()) as { data?: PendingPrompt[] }
  return body.data ?? []
}
