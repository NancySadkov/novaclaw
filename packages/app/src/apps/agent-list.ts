// Loading the roster from the instance — WHO works here, and WHAT they are working on. One loader
// each, because several surfaces now ask the same two questions and a second copy is how they start
// disagreeing about who exists.

import { ConfigAgent } from "@novaclaw/core/config/agent"
import * as Timestamp from "@novaclaw/schema/time"
import type { AgentLike } from "./contacts"
import type { SessionLike, UsageMinute } from "./roster-live"

/** The V2 agent list, which is the ONE shape carrying the roster profile.
 *
 *  ⚠️ Deliberately NOT the global sync store's `data.agent`: that reads the legacy `GET /agent`
 *  projection whose entries are keyed by `name` and carry no `title`, `personality`, `avatar` or
 *  `memory`. Two shapes for one concept is a migration this page must not silently depend on — filed
 *  in `notes/named-agents.md`. */
export const listAgents = async (sdk: {
  agent: { list: () => Promise<{ data?: unknown; error?: unknown }> }
}): Promise<AgentLike[]> => {
  const response = await sdk.agent.list()
  /**
   * 🔴 **A FAILED read is not an empty roster** (owner, 2026-08-28: *"contacts app now has no
   * contacts. Not even Nova itself … lack of agents (i.e. even nova itself being dead) should trigger
   * Novaclaw recovery sequence"*).
   *
   * The SDK does not throw on an HTTP failure — it hands back `{ data?, error? }`. This function read
   * only `data`, so a 401, a 500 or an instance that had gone away arrived as `data: undefined`, fell
   * through `body?.data ?? []`, and was returned as a SUCCESSFUL empty list. `global.tsx` keeps the
   * roster's failure precisely so Contacts can say "we could not read who you have" instead of "you
   * have nobody" — and it never saw one, because there was never a rejection to catch.
   *
   * Measured on the owner's instance: it was pointed at a LAN instance that was no longer running,
   * and every surface reported an organization with no people in it, Nova included.
   */
  if (response.error !== undefined && response.error !== null) throw response.error
  // ⚠️ TWO `data` hops, and they are different things. The SDK wraps the HTTP body as
  // `{ data: body }`, and every V2 location-scoped endpoint wraps its payload again as
  // `{ location, data }` (`Location.response`). Reading one hop yields the ENVELOPE — an object, not
  // an array — which `Array.isArray` then rejects into an empty roster that looks like "you have no
  // colleagues". Measured against the live instance: `GET /api/agent` returned build, plan, nova,
  // general and explore while this page rendered the empty state.
  const body = response.data as { readonly data?: unknown } | undefined
  const rows = (Array.isArray(body) ? body : (body?.data ?? [])) as ReadonlyArray<Record<string, unknown>>
  // ⚠️ THROWS rather than returning `[]`. A body this cannot read is a fault ABOUT THE RESPONSE, and
  // the empty array it used to return was indistinguishable from a real answer — which is how the
  // envelope bug described above stayed invisible until somebody opened the page and saw nobody.
  if (!Array.isArray(rows)) throw new Error("agent.list returned a body that is not a list of agents")
  const mapped = rows.flatMap((row) => {
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
        // 🔴 The SAME hand-kept-subset defect as `workspace` below, and it disabled two controls at
        // once. `paused` is set server-side from config `disabled: true`, is declared on the wire
        // (`schema/agent.ts`), is mapped by `contacts.ts` (`agent.paused === true`) and is rendered
        // as a badge (`pages/contacts.tsx`) — every link in the chain existed except this one, so the
        // badge never appeared AND the config dialog's button always read "Pause". Clicking it on an
        // already-paused colleague re-wrote `disabled: true`, which is why Resume was UNREACHABLE.
        paused: row["paused"] === true,
        name: text("name"),
        title: text("title"),
        description: text("description"),
        personality: text("personality"),
        superior: text("superior"),
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
        /**
         * What this colleague is working on — carried explicitly for exactly the reason `workspace`
         * above documents: this mapper is a hand-kept subset, and a derived field appears in no
         * config schema, so nothing spreads it in. The ledger test is what caught it here.
         *
         * ⚠️ Absent stays absent. `undefined` means the colleague has no line yet, and Contacts
         * renders the row without a status rather than with an empty one.
         */
        ...(row["status"] && typeof row["status"] === "object"
          ? { status: row["status"] as { task: string; observed: number } }
          : {}),
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
  /**
   * 🔴 **An EMPTY roster is a fault, not an answer** (owner, 2026-08-28: *"can't have sessions
   * without any agents, and lack of agents (i.e. even nova itself being dead) should trigger Novaclaw
   * recovery sequence"*).
   *
   * Nova is this instance's governing agent: protected from removal through every door
   * (`AgentV2.isProtected`) and built in rather than configured, so it cannot be absent from a healthy
   * instance — nor can `build` and `plan`. Zero colleagues therefore never describes an organization.
   * It describes a read that did not work, or an instance that is not answering.
   *
   * Throwing routes it to the failure the roster already keeps and Contacts already renders, instead
   * of leaving every surface to present an empty company it has no way to question.
   */
  if (mapped.length === 0) throw new Error("agent.list returned no agents — an instance always has at least Nova")
  return mapped
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
    const created = Timestamp.toEpochMillis(time?.created)
    if (id === undefined || created === undefined) return []
    const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined)
    const updated = Timestamp.toEpochMillis(time?.updated)
    const archived = Timestamp.toEpochMillis(time?.archived)
    return [
      {
        id,
        parentID: text("parentID"),
        agent: text("agent"),
        type:
          row["type"] === "interactive" ||
          row["type"] === "sub-agent" ||
          row["type"] === "auto-prompting" ||
          row["type"] === "goal-oriented"
            ? row["type"]
            : undefined,
        title: text("title"),
        tokens: row["tokens"] as SessionLike["tokens"],
        time: {
          created,
          ...(updated === undefined ? {} : { updated }),
          ...(archived === undefined ? {} : { archived }),
        },
      } satisfies SessionLike,
    ]
  })
}

/** Every colleague's per-minute output, keyed by agent id.
 *
 *  The endpoint is batched so a roster refresh has one HTTP round trip, not one request per colleague.
 *  The response keeps missing series as empty arrays, so a partial server result cannot hide a roster
 *  row or make one colleague's read failure blank everyone else's rate.
 */
export const listUsage = async (
  sdk: { agent: { usageMany: (input: { agentIDs: readonly string[] }) => Promise<{ data?: unknown }> } },
  agentIDs: readonly string[],
): Promise<Record<string, readonly UsageMinute[]>> => {
  const result: Record<string, readonly UsageMinute[]> = Object.fromEntries(agentIDs.map((id) => [id, []]))
  if (agentIDs.length === 0) return result
  try {
    const response = await sdk.agent.usageMany({ agentIDs })
    const body = response.data as { readonly data?: unknown } | undefined
    const payload = body !== undefined && !Array.isArray(body) && body.data !== undefined ? body.data : body
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return result
    for (const agentID of agentIDs) {
      const rows = (payload as Record<string, unknown>)[agentID]
      if (!Array.isArray(rows)) continue
      result[agentID] = rows.flatMap((row) =>
        row !== null &&
        typeof row === "object" &&
        typeof row["minute"] === "number" &&
        typeof row["generated"] === "number"
          ? [{ minute: row["minute"], generated: row["generated"] }]
          : [],
      )
    }
  } catch {
    // A failed batch dims every rate, but must not reject the Contacts roster itself.
  }
  return result
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
