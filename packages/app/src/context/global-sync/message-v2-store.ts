import { createStore, produce } from "solid-js/store"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { applySessionNextEvent, mergeNativeMessages } from "@novaclaw/session-ui/v2/message-fold"
import { fetchNativeMessages } from "./message-v2-fetch"

/**
 * The native transcript store — THE render path (`NativeTimeline` → `NativeTranscript`).
 * Holds `SessionMessage[]` per session, folded from the live `session.next.*` stream
 * (`applySessionNextEvent`) and bootstrapped/reconciled from the native history fetch
 * (`fetchNativeMessages` + `mergeNativeMessages`). `server-session.ts` is a different
 * store (session rows, permissions, todos) — it carries no messages.
 *
 * Because it renders, a stale row here is a user-visible bug, which is why `load`
 * passes the reconcile bounds below rather than merging as a pure union.
 *
 * `apply` consumes the SDK `V2Event` `{ type, data }` shape and routes by
 * `data.sessionID`. Non-`session.next.*` events are ignored.
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
