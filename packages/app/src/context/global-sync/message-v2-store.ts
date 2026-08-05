import { createStore, produce } from "solid-js/store"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { appendMessage, applySessionNextEvent, mergeNativeMessages } from "@novaclaw/session-ui/v2/message-fold"
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

  /**
   * Show a message the user has just sent, BEFORE the server has echoed it.
   *
   * Why this exists: `sendFollowupDraft` waits on the worktree (budgeted at five minutes), possibly a
   * `switchModel` and a `switchAgent`, and only then POSTs the prompt — so between pressing Enter and
   * the `session.next.prompted` echo the user's own words are nowhere on screen. Owner, 2026-08-05:
   * *"the prompt gets queued, but doesn't immediately show ... which gives user impression it
   * disappeared."* Losing a person's words is the one failure a chat UI cannot have.
   *
   * Three properties make this safe rather than a second source of truth:
   *  · The id is the one the client already generates and sends as `prompt({id})`, so the server's
   *    echo carries the SAME id — and `appendMessage` ignores an id it already holds, so the echo
   *    cannot duplicate this row.
   *  · A later authoritative fetch replaces it with the server's own copy (fetched wins for settled
   *    messages), so any divergence heals rather than persisting.
   *  · ⚠️ `time.created` MUST be real. `mergeNativeMessages` drops a local row only when it is both
   *    `withinPage` AND `predatesFetch`, and a missing timestamp makes `predatesFetch` TRUE — so a row
   *    without one would appear and then BLINK OUT on the next reconcile, which is worse than the bug
   *    this fixes. Callers pass `Date.now()`; the merge then keeps it by its own rule ("created AFTER
   *    the fetch ⇒ it simply arrived too late to be included").
   */
  const optimistic = (sessionID: string, message: SessionMessage) =>
    setData(
      "messages",
      produce((bySession) => {
        appendMessage((bySession[sessionID] ??= []), message)
      }),
    )

  /**
   * Take back an optimistic row whose send FAILED.
   *
   * Without this the fix would trade a missing message for a lying one: the user would see their
   * prompt sitting in the transcript as though it had landed, when nothing was ever sent. A message
   * that is never reconciled is the worse of the two failures, because it is believed.
   */
  const forget = (sessionID: string, messageID: string) =>
    setData(
      "messages",
      produce((bySession) => {
        const list = bySession[sessionID]
        if (!list) return
        const index = list.findIndex((message) => message.id === messageID)
        if (index >= 0) list.splice(index, 1)
      }),
    )

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
    optimistic,
    forget,
    evict,
  }
}

export type NativeMessageStore = ReturnType<typeof createNativeMessageStore>
