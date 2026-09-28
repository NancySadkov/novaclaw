// Loading the roster from the instance — WHO works here, and WHAT they are working on. One loader
// each, because several surfaces now ask the same two questions and a second copy is how they start
// disagreeing about who exists.

import { ConfigAgent } from "@novaclaw/core/config/agent"
import * as Timestamp from "@novaclaw/schema/time"
import type { AgentLike } from "./contacts"
import { chatFor, type SessionLike, type UsageMinute } from "./roster-live"

/** The V2 agent list, which is the ONE shape carrying the roster profile.
 *
 *  ⚠️ Deliberately NOT the global sync store's `data.agent`: that reads the legacy `GET /agent`
 *  projection whose entries are keyed by `name` and carry no `title`, `personality`, `avatar` or
 *  `memory`. Two shapes for one concept is a migration this page must not silently depend on — filed
 *  in `notes/named-agents.md`. */
export const listAgents = async (sdk: {
  agent: { list: (parameters?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: unknown; error?: unknown }> }
}, signal?: AbortSignal): Promise<AgentLike[]> => {
  const response = await sdk.agent.list(undefined, { signal })
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
        // ⚠️ Carried EXPLICITLY for the reason `workspace` above documents: this mapper is a hand-kept
        // subset, and a stored `toolLabels: false` dying here made the config dialog's caption switch
        // read ON forever — so switching it OFF looked like a save that did nothing, while the switch
        // itself was never marked dirty. The `config` spread below does hold it, but the dialog reads
        // the lifted field, and `AgentLike` declares it.
        ...(typeof row["toolLabels"] === "boolean" ? { toolLabels: row["toolLabels"] } : {}),
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
import { agentChatRefusal } from "@/utils/server-errors"

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
          row["type"] === "goal-oriented"
            ? row["type"]
            : undefined,
        title: text("title"),
        ...(typeof (row["location"] as { directory?: unknown } | undefined)?.directory === "string"
          ? { location: { directory: (row["location"] as { directory: string }).directory } }
          : {}),
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

/**
 * The chat a COLLEAGUE holds right now — its live one, or a fresh canonical chat when it has none.
 *
 * 🔴 **The recovery half of officer routes** (owner, 2026-09-26). A tab and a route name a session id,
 * but a colleague is the ENTITY and its chat is a COMPONENT: when that id is gone (Clear chat removed
 * it, or the sidecar restarted before the replacement was opened) the route must follow the colleague
 * rather than render *"This chat was deleted or has expired"*. `chatFor` answers with the live chat;
 * when the colleague has none — e.g. it was just cleared and the successor never opened — `startChat`
 * creates the canonical chat, so an officer route ALWAYS lands on a real transcript.
 *
 * ⚠️ Only for colleague tabs. An anonymous or worker chat has no entity to follow, so a missing id
 * there is genuinely gone and the caller keeps the existing retirement policy.
 */
/**
 * The last chat known for a colleague, keyed `server\nagent` — a CACHE, never identity. The tab holds
 * only the agent; this only spares a full session list on every open. Seeded the moment a chat is
 * created or resolved, so opening a colleague is instant (owner, 2026-09-26: a tab click should not
 * feel like a signal from Mars).
 */
export interface OfficerChat {
  readonly id: string
  /**
   * The chat's location, cached with the id. Rendering the session page needs BOTH, and a cache that
   * only knew the id still had to fetch the record for its directory before anything appeared —
   * which is exactly the "signal from Mars" the owner reported on an empty, previously-opened chat
   * (2026-09-26).
   */
  readonly directory?: string
}

const officerChatCache = new Map<string, OfficerChat>()

const cacheKey = (serverKey: string, agentID: string) => `${serverKey}\n${agentID}`

export const rememberOfficerChat = (
  serverKey: string,
  agentID: string,
  sessionID: string,
  directory?: string,
): void => {
  const previous = officerChatCache.get(cacheKey(serverKey, agentID))
  officerChatCache.set(cacheKey(serverKey, agentID), {
    id: sessionID,
    directory: directory ?? (previous?.id === sessionID ? previous.directory : undefined),
  })
}

export const cachedOfficerChat = (serverKey: string, agentID: string): OfficerChat | undefined =>
  officerChatCache.get(cacheKey(serverKey, agentID))

/**
 * 🔴 "Which chat is this colleague's" is answered by the INSTANCE, never derived here.
 *
 * This used to fold `listSessions(sdk)`, whose request carries no `limit` and therefore returns the
 * newest 50 sessions (the protocol's documented default; `handlers/session.ts:90`). A colleague whose
 * current chat fell outside that page was answered with an older chat — or with nothing, which is the
 * same value that means "this colleague has never had a chat", and this function CREATES a chat on
 * nothing. So the failure mode was: open a colleague you have been talking to all day, land in a
 * stranger's transcript, or start a second one.
 *
 * `GET /api/agent/{agentID}/chat` answers it from SQL via the kernel's own `RosterChat.chatFor`, and
 * 404s when there is genuinely nothing — which is a real answer, not a failed load, and is the only
 * thing that should authorise `startChat` below.
 */
/**
 * The instance's answer, with its two "no"s kept apart.
 *
 * ⚠️ The generated client THROWS on a non-2xx, so both negative answers arrive as exceptions. They are
 * caught by KIND and never by message, and they are NOT the same fact:
 *
 *   - `no_chat`   — the colleague is real and has simply never been opened. The one state that may
 *                   authorise creating a first chat.
 *   - `no_agent`  — there is no such agent. Creating here would write a transcript owned by a phantom,
 *                   and the kernel says why this needs saying at all: `RosterChat.chatFor` reads rows
 *                   and cannot tell a chatless colleague from one that does not exist
 *                   (colleague-handoff.ts). The instance now asks the roster first and says which.
 *
 * Anything else propagates. A colleague whose chat could not be READ is not a colleague without a chat,
 * and answering it with a blank is how a second conversation appears beside a real one.
 */
type OfficerChatAnswer =
  | { readonly kind: "chat"; readonly id: string; readonly directory: string }
  | { readonly kind: "no_chat" }
  | { readonly kind: "no_agent" }

const officerChat = async (
  sdk: { agent: { chat: (input: { agentID: string }) => Promise<unknown> } },
  agentID: string,
): Promise<OfficerChatAnswer> => {
  try {
    const response = (await sdk.agent.chat({ agentID })) as {
      data?: { data?: { id?: string; directory?: string } }
    }
    const chat = response?.data?.data
    // A 200 with no id is the instance contradicting its own contract. Treating it as `no_chat` would
    // authorise creating a chat over one that exists, so it is a fault and it propagates.
    if (!chat?.id) throw new Error(`the instance answered ${agentID}'s chat with no id`)
    return { kind: "chat", id: chat.id, directory: chat.directory ?? "" }
  } catch (error) {
    const refusal = agentChatRefusal(error, agentID)
    if (refusal) return { kind: refusal === "agent_not_found" ? "no_agent" : "no_chat" }
    throw error
  }
}

export const resolveOfficerChat = async (
  sdk: {
    agent: { chat: (input: { agentID: string }) => Promise<unknown> }
  } & Parameters<typeof startChat>[0],
  input: {
    readonly agentID: string
    readonly title?: string | undefined
    readonly create?: boolean | undefined
    readonly serverKey?: string | undefined
  },
): Promise<string | undefined> => {
  const answer = await officerChat(sdk, input.agentID)
  if (answer.kind === "chat") {
    if (input.serverKey !== undefined)
      rememberOfficerChat(input.serverKey, input.agentID, answer.id, answer.directory)
    return answer.id
  }
  // 🔴 No chat, but ALSO no such colleague. Creating here writes a transcript owned by a name that is
  // not an agent, and the caller cannot tell that from the quiet state it asked for — so it is refused
  // outright rather than turned into an empty first chat.
  if (answer.kind === "no_agent") return undefined
  // ⚠️ A route that merely OPENS a colleague must not CREATE a chat as a side effect of navigation
  // (owner, 2026-09-26). `create: false` returns nothing and the caller shows a quiet state; creating
  // is what the roster's own "open to start one" gesture does, deliberately.
  if (input.create === false) return undefined
  const created = await startChat(sdk, { agentID: input.agentID, title: input.title ?? input.agentID })
  if (created !== undefined && input.serverKey !== undefined)
    rememberOfficerChat(input.serverKey, input.agentID, created)
  return created
}
