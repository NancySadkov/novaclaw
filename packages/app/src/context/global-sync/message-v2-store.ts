import { createStore, produce } from "solid-js/store"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { applySessionNextEvent, mergeNativeMessages } from "@novaclaw/session-ui/v2/message-fold"
import { fetchNativeMessages } from "./message-v2-fetch"

/**
 * Parallel native-V2 transcript store (F1e strategy B). Holds `SessionMessage[]` per
 * session, folded from the live `session.next.*` stream (`applySessionNextEvent`) and
 * bootstrapped/reconciled from the native history fetch (`fetchNativeMessages` +
 * `mergeNativeMessages`). Runs ALONGSIDE the V1 `server-session.ts` store — nothing
 * renders from it yet (S4 flips the render); V1 stays authoritative until then.
 *
 * `apply` consumes the SDK `V2Event` `{ type, data }` shape and routes by
 * `data.sessionID`; the SSE layer's dropped durable `sync` envelope is adapted to that
 * shape and fed here in the next slice. Non-`session.next.*` events are ignored.
 */
export function createNativeMessageStore(client: NovaclawClient) {
  const [data, setData] = createStore({ messages: {} as Record<string, SessionMessage[]> })

  const apply = (event: V2Event) => {
    if (!event.type.startsWith("session.next.")) return
    const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID
    if (!sessionID) return
    setData(
      "messages",
      produce((bySession) => {
        applySessionNextEvent((bySession[sessionID] ??= []), event)
      }),
    )
  }

  const load = async (sessionID: string, options?: { limit?: number; order?: "asc" | "desc"; cursor?: string }) => {
    // Stamp BEFORE the request: the response describes server state as of this moment, which lets the
    // merge tell a deleted row from one that arrived while the request was in flight.
    const asOf = Date.now()
    const fetched = await fetchNativeMessages(client, sessionID, options)
    setData(
      "messages",
      produce((bySession) => {
        // No cursor ⇒ this is a full reconcile of the newest page, so it is authoritative about what
        // still exists in that range and may DROP rows the server deleted (e.g. a revert we missed).
        bySession[sessionID] = mergeNativeMessages(bySession[sessionID] ?? [], fetched, {
          authoritative: options?.cursor === undefined,
          asOf,
        })
      }),
    )
  }

  const evict = (sessionID: string) =>
    setData(
      "messages",
      produce((bySession) => {
        delete bySession[sessionID]
      }),
    )

  return {
    data,
    messages: (sessionID: string): SessionMessage[] | undefined => data.messages[sessionID],
    apply,
    load,
    evict,
  }
}

export type NativeMessageStore = ReturnType<typeof createNativeMessageStore>
