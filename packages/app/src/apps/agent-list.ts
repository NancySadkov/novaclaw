// Loading the roster from the instance. ONE loader, because two surfaces now ask the same question
// ("who works here?") and a second copy is how they start disagreeing about who exists.

import type { AgentLike } from "./contacts"

/** The V2 agent list, which is the ONE shape carrying the roster profile.
 *
 *  ⚠️ Deliberately NOT the global sync store's `data.agent`: that reads the legacy `GET /agent`
 *  projection whose entries are keyed by `name` and carry no `title`, `personality`, `avatar` or
 *  `memory`. Two shapes for one concept is a migration this page must not silently depend on — filed
 *  in `todo/named-agents.md`. */
export const listAgents = async (sdk: { agent: { list: () => Promise<{ data?: unknown }> } }): Promise<AgentLike[]> => {
  const response = await sdk.agent.list()
  // ⚠️ TWO `data` hops, and they are different things. The SDK wraps the HTTP body as
  // `{ data: body }`, and every V2 location-scoped endpoint wraps its payload again as
  // `{ location, data }` (`Location.response`). Reading one hop yields the ENVELOPE — an object, not
  // an array — which `Array.isArray` then rejects into an empty roster that looks like "you have no
  // colleagues". Measured against the live instance: `GET /api/agent` returned build, plan, nova,
  // general and explore while this page rendered the empty state.
  const body = response.data as { readonly data?: unknown } | undefined
  const rows = (Array.isArray(body) ? body : (body?.data ?? [])) as ReadonlyArray<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const id = typeof row["id"] === "string" ? row["id"] : undefined
    const mode = row["mode"]
    if (id === undefined || (mode !== "primary" && mode !== "subagent" && mode !== "all")) return []
    const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined)
    const memory = row["memory"] === "none" ? ("none" as const) : row["memory"] === "own" ? ("own" as const) : undefined
    return [
      {
        id,
        mode,
        hidden: row["hidden"] === true,
        name: text("name"),
        title: text("title"),
        description: text("description"),
        personality: text("personality"),
        avatar: text("avatar"),
        color: text("color"),
        memory,
      } satisfies AgentLike,
    ]
  })
}
