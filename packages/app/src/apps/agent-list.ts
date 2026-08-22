// Loading the roster from the instance — WHO works here, and WHAT they are working on. One loader
// each, because several surfaces now ask the same two questions and a second copy is how they start
// disagreeing about who exists.

import { ConfigAgent } from "@novaclaw/core/config/agent"
import type { AgentLike } from "./contacts"
import type { SessionLike, UsageMinute } from "./roster-live"

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
        system: text("system"),
        ...(typeof (row["model"] as { providerID?: unknown } | undefined)?.providerID === "string"
          ? { model: row["model"] as { providerID: string; id: string } }
          : {}),
        avatar: text("avatar"),
        // ⚠️ Carried EXPLICITLY because this mapper is a hand-kept subset, and it dropped this field
        // silently: the roster response stamped `workspace`, the API returned it, and the config
        // dialog's "Browse …'s workspace" link never rendered because the value did not survive the
        // trip. Same shape as the clone list, which lost `model`, `archiveChats`, `color` and `steps`
        // the same way. It is NOT in `config` either — that spread is keyed on
        // `ConfigAgent.Info.fields`, and `workspace` is derived rather than authored, so it appears
        // in no config schema by design.
        workspace: text("workspace"),
        color: text("color"),
        memory,
        ...(typeof row["archiveChats"] === "boolean" ? { archiveChats: row["archiveChats"] } : {}),
        // Everything the CONFIG schema declares, verbatim — the clone's source of truth. Derived from
        // the schema rather than listed here, because a hand-kept projection is exactly what dropped
        // `steps` on the way to a clone (see `AgentLike.config`).
        config: Object.fromEntries(
          Object.keys(ConfigAgent.Info.fields)
            .filter((key) => row[key] !== undefined && row[key] !== null)
            .map((key) => [key, row[key]]),
        ),
      } satisfies AgentLike,
    ]
  })
}

/** Every session this instance holds, for the roster's work column.
 *
 *  ⚠️ Deliberately NOT the Tasks page's loader. That one is folder-scoped — it walks project
 *  directories, the scratch dir and a child-session hydration pass — because a CHAT LIST is
 *  organised by where the work happens. A roster is organised by WHO does it, so it asks the
 *  instance for its sessions once and groups them by agent. */
export const listSessions = async (sdk: {
  session: { list: () => Promise<{ data?: unknown }> }
}): Promise<SessionLike[]> => {
  const response = await sdk.session.list()
  const body = response.data as { readonly data?: unknown } | undefined
  const rows = (Array.isArray(body) ? body : (body?.data ?? [])) as ReadonlyArray<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const id = typeof row["id"] === "string" ? row["id"] : undefined
    const time = row["time"] as { created?: unknown; updated?: unknown; archived?: unknown } | undefined
    if (id === undefined || typeof time?.created !== "number") return []
    const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined)
    const number = (value: unknown) => (typeof value === "number" ? value : undefined)
    return [
      {
        id,
        parentID: text("parentID"),
        agent: text("agent"),
        title: text("title"),
        tokens: row["tokens"] as SessionLike["tokens"],
        time: {
          created: time.created,
          ...(number(time.updated) === undefined ? {} : { updated: number(time.updated) }),
          ...(number(time.archived) === undefined ? {} : { archived: number(time.archived) }),
        },
      } satisfies SessionLike,
    ]
  })
}

/** Every colleague's per-minute output, keyed by agent id.
 *
 *  ⚠️ One request PER COLLEAGUE, and deliberately so: the endpoint is per-agent because spend
 *  belongs to a colleague, and a roster holds a handful of them by design (that is the whole point
 *  of replacing a list that grew forever). A batch endpoint would be the right answer for a hundred
 *  agents, and a hundred agents is the thing this product says no to.
 *
 *  A failure for one colleague dims that colleague's rate and nothing else — the roster still lists
 *  everyone, because "who works here" did not fail. */
export const listUsage = async (
  sdk: { agent: { usage: (input: { agentID: string }) => Promise<{ data?: unknown }> } },
  agentIDs: readonly string[],
): Promise<Record<string, readonly UsageMinute[]>> => {
  const entries = await Promise.all(
    agentIDs.map(async (agentID) => {
      try {
        const response = await sdk.agent.usage({ agentID })
        const body = response.data as { readonly data?: unknown } | undefined
        const rows = (Array.isArray(body) ? body : (body?.data ?? [])) as ReadonlyArray<Record<string, unknown>>
        if (!Array.isArray(rows)) return [agentID, [] as UsageMinute[]] as const
        const series = rows.flatMap((row) =>
          typeof row["minute"] === "number" && typeof row["generated"] === "number"
            ? [{ minute: row["minute"], generated: row["generated"] }]
            : [],
        )
        return [agentID, series] as const
      } catch {
        return [agentID, [] as UsageMinute[]] as const
      }
    }),
  )
  return Object.fromEntries(entries)
}

/**
 * Start a colleague's chat.
 *
 * 🔴 The roster row says "No chat yet — open to start one", so opening MUST start one. The first
 * version of that row opened the config instead, which made the copy a small lie — and a product
 * whose own words do not match its buttons is the thing this UI is written against.
 *
 * The session is bound to the colleague at CREATION (`agent`), which is what makes it theirs: the
 * roster finds a chat by agent id, the memory scope keys on the same id, and a chat created without
 * it would belong to nobody.
 */
export const startChat = async (
  sdk: { session: { create: (input: Record<string, unknown>) => Promise<{ data?: unknown }> } },
  input: { readonly agentID: string; readonly title: string },
): Promise<string | undefined> => {
  const response = await sdk.session.create({ agent: input.agentID, title: input.title })
  const body = response.data as { readonly data?: { readonly id?: unknown }; readonly id?: unknown } | undefined
  const id = body?.data?.id ?? body?.id
  return typeof id === "string" ? id : undefined
}
