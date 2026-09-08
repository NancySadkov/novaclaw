import { createStore, produce } from "solid-js/store"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import {
  appendMessage,
  applySessionNextEvent,
  isOptimistic,
  mergeNativeMessages,
} from "@novaclaw/session-ui/v2/message-fold"
export { OPTIMISTIC_METADATA_KEY } from "@novaclaw/session-ui/v2/message-fold"
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
 * `data.sessionID`. Besides `session.next.*` it reads exactly two control events — a chat's
 * deletion, and its archiving — to drop that chat's transcript. Everything else is ignored.
 */
export function createNativeMessageStore(client: NovaclawClient) {
  const [data, setData] = createStore({ messages: {} as Record<string, SessionMessage[]> })
  // Requested transcripts, including a first load that failed before it could create a store row.
  // Reconnect recovery must retry those too or a chat opened during an outage stays blank forever.
  const heldSessions = new Set<string>()
  // Full (no-cursor) loads are authoritative snapshots. A mount load and the busy→idle
  // recovery load can overlap, so only the newest snapshot for a session may commit. Cursor
  // loads deliberately do not share this fence: they add an older page and must retain their
  // independent pagination semantics.
  const authoritativeLoadRev = new Map<string, number>()

  const apply = (event: V2Event) => {
    // A retired id returns — clear everything keyed on it. `server-session` drops its own caches
    // for these two events; until 2026-09-03 nothing dropped the transcript, so every chat the user
    // had opened stayed resident for the life of the connection however many they deleted. An
    // archived chat that is opened again is refetched by `load`, exactly like a first open.
    const retired = retiredSession(event)
    if (retired !== undefined) return evict(retired)
    if (!event.type.startsWith("session.next.")) return
    const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID
    if (!sessionID) return
    setData(
      "messages",
      produce((bySession) => {
        const list = (bySession[sessionID] ??= [])
        // ⚠️ The server's echo of a message we already showed OPTIMISTICALLY has to REPLACE it, not be
        // ignored. `appendMessage` skips an id it already holds, which is what stops the echo
        // duplicating the row — but it would also strip the echo of its power to *settle* it, leaving
        // the row marked pending forever and the client's own text/timestamp standing in for the
        // server's. Dropping ours first lets the normal fold append the canonical version, so "sending"
        // becomes "sent" on the same event that proves it.
        if (event.type === "session.next.prompted") {
          const echoed = (event.data as { messageID?: string } | undefined)?.messageID
          const index = echoed === undefined ? -1 : list.findIndex((message) => message.id === echoed)
          if (index >= 0 && isOptimistic(list[index])) list.splice(index, 1)
        }
        applySessionNextEvent(list, event)
      }),
    )
  }

  const load = async (sessionID: string, options?: { limit?: number; order?: "asc" | "desc"; cursor?: string }) => {
    heldSessions.add(sessionID)
    const authoritative = options?.cursor === undefined
    const rev = authoritative ? (authoritativeLoadRev.get(sessionID) ?? 0) + 1 : undefined
    if (rev !== undefined) authoritativeLoadRev.set(sessionID, rev)
    // Stamp BEFORE the request: the response describes server state as of this moment, which lets the
    // merge tell a deleted row from one that arrived while the request was in flight.
    const asOf = Date.now()
    const fetched = await fetchNativeMessages(client, sessionID, options)
    // A later authoritative request has already captured a newer server snapshot. Committing this
    // older response would let an incomplete assistant regress a completed reply (and could also
    // resurrect rows a newer snapshot proved deleted).
    if (authoritative && authoritativeLoadRev.get(sessionID) !== rev) return
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

  const evict = (sessionID: string) => {
    heldSessions.delete(sessionID)
    authoritativeLoadRev.set(sessionID, (authoritativeLoadRev.get(sessionID) ?? 0) + 1)
    setData(
      "messages",
      produce((bySession) => {
        delete bySession[sessionID]
      }),
    )
  }
  /** The id a `session.deleted` or an archiving `session.updated` retires, else `undefined`. */
  const retiredSession = (event: V2Event): string | undefined => {
    if (event.type !== "session.deleted" && event.type !== "session.updated") return undefined
    const info = (event.data as { info?: { id?: string; time?: { archived?: number } } } | undefined)?.info
    if (!info?.id) return undefined
    return event.type === "session.deleted" || info.time?.archived ? info.id : undefined
  }

  /**
   * Re-read every transcript this client is holding, from the server.
   *
   * 🔴 **The transcript had no recovery path of its own, and that is how a chat freezes mid-answer.**
   * Reproduced 2026-09-03 against the owner's own 121-message session: stop the server, let two
   * messages land while the stream is down, bring it back. The client reconnects, `server.connected`
   * arrives, every TanStack query under the server's scope is invalidated — and the transcript store
   * is not a query, so it is not among them. The two messages stay invisible until the page is
   * reloaded by hand, which is exactly what the owner saw: *"its response message is cut from the
   * chat … both these prompts and model's answer to them didn't appeared"*.
   *
   * ⚠️ **The one reconcile that did exist could not fire.** `native-timeline` reloads when a session
   * goes busy → idle, and it learns that transition FROM THE STREAM. A recovery whose trigger rides
   * the channel it exists to recover from is not a recovery: while the stream is down there are no
   * events, so there is no transition, so nothing reloads — and once it returns, the turn has long
   * since settled and the edge never comes.
   *
   * Held sessions only, so this costs one request per open chat and nothing for chats nobody opened.
   * `load` is already idempotent and authoritative, so calling it twice is harmless.
   */
  const reconcileAll = async () => {
    const sessions = new Set([...heldSessions, ...Object.keys(data.messages)])
    const results = await Promise.allSettled([...sessions].map((sessionID) => load(sessionID)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    // Finish every independent read before rejecting: one broken chat must not abandon the others,
    // but it also means the renderer is not synchronized. The reconnect barrier retries the sweep.
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "transcript reconciliation failed",
      )
  }

  return {
    data,
    messages: (sessionID: string): SessionMessage[] | undefined => data.messages[sessionID],
    apply,
    load,
    reconcileAll,
    optimistic,
    forget,
    evict,
  }
}

export type NativeMessageStore = ReturnType<typeof createNativeMessageStore>
