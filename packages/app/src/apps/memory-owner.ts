// WHOSE memory the Memory app is showing (AGENTS.md → *the structural metaphor*; the filing-cabinet
// row of the table). Before the roster there was one pile and the question had no answer; now every
// memory belongs to a colleague, to one chat, or to the household — and the app has to say which.
//
// The vocabulary lives here, not in the page, because these are product statements: what a scope is
// CALLED is what the user believes about who can read it.

import { displayName, roster, type AgentLike, type ContactView } from "./contacts"

/** The owner named by one Memory route. */
export interface MemoryOwner {
  /** `agent:<id>`, or the sentinel `global` for the household's shared facts. */
  readonly key: string
  readonly label: string
  /** The scopes to query for this owner. */
  readonly scopes: readonly string[]
  readonly kind: "agent" | "shared"
}

/** The household's shared facts — readable by every colleague, on purpose: partitioning what the
 *  user is like would make each new colleague a stranger. It is an OWNER reached from the household
 *  row rather than a checkbox on somebody else's cabinet, so "who knows this?" has one answer. */
export const SHARED_KEY = "global"

export const ownersFor = (agents: readonly AgentLike[], sharedLabel: string): readonly MemoryOwner[] => [
  ...roster(agents).map(
    (view: ContactView): MemoryOwner => ({
      key: `agent:${view.id}`,
      label: view.name,
      // A colleague's OWN cabinet only. Deliberately not `agent:<id>` ∪ `global`, even though that is
      // what its turns read: this view answers "what does Trader know that nobody else does", and
      // folding the household's facts into every colleague's page would make all of them look
      // identical and hide the very partition the roster promises.
      scopes: [`agent:${view.id}`],
      kind: "agent",
    }),
  ),
  { key: SHARED_KEY, label: sharedLabel, scopes: ["global"], kind: "shared" },
]

/** The owner to show when the app opens, or `undefined` when there is nobody at all. Nova first,
 *  because the CEO is the colleague every instance has and the one a new user has already met. */
export const defaultOwner = (owners: readonly MemoryOwner[]): MemoryOwner | undefined => owners[0]

/**
 * Resolve a REQUESTED owner — the `?owner=` a colleague's config dialog links to.
 *
 * 🔴 The key is the authority for WHICH cabinet to read; the asynchronously loaded roster only
 * decorates it with the colleague's current display name. The old resolver required the colleague to
 * appear in the roster before it would honour `agent:<id>`, then silently fell back to another owner.
 * A slow or failed roster read therefore made both Memory views ask the wrong cabinet and report it
 * empty. A presentation lookup may never redirect a data lookup.
 */
export const ownerFromKey = (owners: readonly MemoryOwner[], key: string | undefined): MemoryOwner | undefined => {
  const found = owners.find((owner) => owner.key === key)
  if (found) return found
  if (key === undefined) return defaultOwner(owners)
  if (!key.startsWith("agent:")) return undefined
  const id = key.slice("agent:".length).trim()
  if (!id) return undefined
  return { key: `agent:${id}`, label: displayName(id), scopes: [`agent:${id}`], kind: "agent" }
}

/** The link a colleague's own memory lives behind. ONE spelling, so the dialog that writes it and
 *  the page that reads it cannot drift. */
export const ownerRoute = (agentID: string): string => `/memory-graph?owner=${encodeURIComponent(`agent:${agentID}`)}`

/** The addressable door back into one colleague's configuration. Memory is a child of that
 * colleague, so its Back control returns here rather than to the launcher or the bare roster. */
export const agentConfigureRoute = (agentID: string): string => `/officers/${encodeURIComponent(agentID)}/settings`

/** Recover an agent id from an owner key without letting raw string slicing spread across routes. */
export const agentIDFromOwnerKey = (key: string): string | undefined => {
  if (!key.startsWith("agent:")) return undefined
  const id = key.slice("agent:".length).trim()
  return id || undefined
}

/** The household's shared facts, which belong to no colleague. Reached from the ROSTER's own row
 *  rather than from a top-level app: under the metaphor the roster is the index of who remembers
 *  what, and the household is one of those whos. */
export const SHARED_ROUTE = `/memory-graph?owner=${SHARED_KEY}`

/** What a stored scope string means, in words a non-expert can act on. Keys, so the page translates.
 *
 *  ⚠️ `session:<id>` stays "one chat" rather than naming the chat: a memory scoped to a conversation
 *  is not addressed to a colleague at all, and dressing it up as one would misstate who can read it. */
export const scopeLabelKey = (scope: string): "memory.scope.shared" | "memory.scope.chat" | "memory.scope.agent" =>
  scope === "global" ? "memory.scope.shared" : scope.startsWith("session:") ? "memory.scope.chat" : "memory.scope.agent"

/** The colleague a scope belongs to, if it belongs to one. Used to put a NAME on the badge rather
 *  than the raw `agent:talent-scout` key the store holds. */
export const scopeOwnerName = (scope: string, owners: readonly MemoryOwner[]): string | undefined =>
  owners.find((owner) => owner.kind === "agent" && owner.key === scope)?.label
