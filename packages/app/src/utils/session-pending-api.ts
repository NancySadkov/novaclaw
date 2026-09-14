import { createSignal } from "solid-js"
import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// Prompts the user has SENT but the agent has not read yet.
//
// A prompt submitted mid-turn is admitted durably and answered later, but it is not a transcript message
// until the runner promotes it — so without this it simply vanishes from the UI and reappears, answered,
// minutes later. Read from the server rather than rendered optimistically from our own submit, so a prompt
// sent from another device or the messenger gateway shows up here too.

export interface PendingPrompt {
  id: string
  text: string
  delivery: "steer" | "queue"
  editable: boolean
  timeCreated: number
  origin?: {
    via: string
    sessionID?: string
    label?: string
    relation?: string
    turn?: "ask" | "answer" | "announce"
    announce?: boolean
    conversation?: string
    participants?: string[]
  }
}

/**
 * A nudge that says "ask again NOW" instead of waiting out the interval.
 *
 * The poll below runs every 2 s while a turn is in flight, and its effect's dependencies (connection,
 * directory, whether a turn is running, how many prompts are already queued) do not change when the
 * user presses Enter. So a prompt sent mid-turn was invisible for up to a full tick — which is what
 * the owner reported as *"it disappeared"*, and two seconds is long enough to retype it.
 *
 * ⚠️ Fire this AFTER the prompt POST resolves, never at submit: before the server has admitted the
 * input there is nothing to fetch, and an early poll just spends a request to return the same empty
 * list. ⚠️ And it is a KICK, not a shorter interval — the gap is "we did not know to look", not "we
 * looked too slowly", so polling faster would burn requests to shrink the same window.
 */
const [kicks, setKicks] = createSignal(0)

/** Read by the polling effect so a kick re-runs it immediately. */
export const pendingPromptsKick = kicks

/** Call once the server has certainly admitted a prompt. */
export const kickPendingPrompts = () => setKicks((value) => value + 1)

/**
 * Failures propagate so the renderer can retain its last known queue. Folding an unreadable queue
 * into `[]` would make every waiting prompt disappear during an outage — absence is not an empty result.
 */
export async function fetchPendingPrompts(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string },
): Promise<PendingPrompt[]> {
  const body = await instanceFetch<{ data?: PendingPrompt[] }>(server, {
    route: `api/session/${input.sessionID}/pending`,
    directory: input.directory,
    directoryVia: "header",
  })
  if (!body.data) throw new Error("Pending prompt response is missing data.")
  return body.data
}

/** Withdraw a prompt only while it is still outside model context. */
export async function cancelPendingPrompt(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; messageID: string },
): Promise<boolean> {
  const body = await instanceFetch<{ data: boolean }>(server, {
    method: "DELETE",
    route: `api/session/${encodeURIComponent(input.sessionID)}/pending/${encodeURIComponent(input.messageID)}`,
    directory: input.directory,
    directoryVia: "header",
  })
  return body.data
}
