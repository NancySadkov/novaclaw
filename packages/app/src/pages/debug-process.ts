import type { NovaclawClient, SessionV2Info } from "@novaclaw/sdk/v2/client"

/**
 * The Debug app's process view must ask the instance for its session roster. The reactive session
 * cache is intentionally bounded and only contains directories this browser has visited, so it is
 * not an authority for an OS-level diagnostic surface.
 *
 * The endpoint is cursor-paginated. Walk every page rather than inventing a client cap: an unseen
 * paused execution is exactly the row this view exists to make actionable. A repeated cursor is a
 * malformed server response, not permission to loop forever.
 */
export async function listDebugSessions(client: NovaclawClient): Promise<SessionV2Info[]> {
  const rows: SessionV2Info[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const response = await client.v2.session.list({
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    })
    rows.push(...(response.data?.data ?? []))

    const next = response.data?.cursor?.next
    if (next === undefined) return rows
    if (seenCursors.has(next)) throw new Error("The instance returned a repeated session-list cursor")
    seenCursors.add(next)
    cursor = next
  }
}

/** Read the instance-owned live execution set for the status column. The session event cache is
 * useful for reactive chat views, but Debug is an OS diagnostic and must join its roster with the
 * server's current active set when it renders a process as running. */
export async function listDebugActiveSessions(
  client: NovaclawClient,
): Promise<Record<string, { readonly type: "running" }>> {
  const response = await client.v2.session.active()
  const data = response.data?.data
  if (data === undefined || data === null || typeof data !== "object") return {}
  return Object.fromEntries(Object.keys(data).map((id) => [id, { type: "running" as const }]))
}
