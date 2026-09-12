import type { NovaclawClient, SessionMessage } from "@novaclaw/sdk/v2/client"

/**
 * Fetch a session's history as native V2 `SessionMessage[]` via
 * `GET /api/session/{id}/message` (`client.v2.session.messages`) — the native
 * counterpart to the V1 `WithParts` fetch in `server-session.ts`. This is the
 * bootstrap source for the strategy-B native message store (F1e): the returned
 * messages seed the store that `applySessionNextEvent` (v2/message-fold) then keeps
 * up to date from the live `session.next.*` stream.
 *
 * Returns one page in the requested order (server default). `cursor` walks the
 * ordered timeline; the store owns pagination. Distinct from the projected
 * `client.session.messages` (`/session/{id}/message` → `{ info, parts }[]`), which is
 * the V1 render vocab this replaces.
 *
 * ⚠️ **`undefined` is not `[]`.** A response that carries no `data` at all means *we did not get an
 * answer* — a proxy error page, a transport hiccup, a server too old to know this field. It does NOT
 * mean the session is empty. Collapsing the two (`?? []`) handed the store an authoritative-looking
 * empty list, and the store drops every local row for an empty full-page fetch, because an empty
 * authoritative fetch is how a genuine full revert is expressed. So "I don't know" was being read as
 * "there is nothing", the transcript emptied, and the next fetch refilled it.
 *
 * Callers MUST treat `undefined` as "no information" and skip their reconcile. Returning `[]` here
 * for an absent payload is the bug, not the contract.
 */
export async function fetchNativeMessages(
  client: NovaclawClient,
  sessionID: string,
  options?: { limit?: number; order?: "asc" | "desc"; cursor?: string },
): Promise<SessionMessage[] | undefined> {
  const response = await client.v2.session.messages(
    { sessionID, limit: options?.limit, order: options?.order, cursor: options?.cursor },
    { throwOnError: true },
  )
  return response.data?.data
}
