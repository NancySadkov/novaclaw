// WHOSE memory the Memory app is showing (AGENTS.md → *the structural metaphor*; the filing-cabinet
// row of the table). Before the roster there was one pile and the question had no answer; now every
// memory belongs to a colleague, to one chat, or to the household — and the app has to say which.
//
// The vocabulary lives here, not in the page, because these are product statements: what a scope is
// CALLED is what the user believes about who can read it.

import { roster, type AgentLike, type ContactView } from "./contacts"

/** One entry in the "whose memory?" picker. */
export interface MemoryOwner {
  /** `agent:<id>`, or the sentinel `global` for the household's shared facts. */
  readonly key: string
  readonly label: string
  /** The scopes to query for this owner. */
  readonly scopes: readonly string[]
  readonly kind: "agent" | "shared"
}

/** The household's shared facts — readable by every colleague, on purpose: partitioning what the
 *  user is like would make each new colleague a stranger. It is an OWNER in this picker rather than
 *  a checkbox, so "who knows this?" always has a name attached. */
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
 * 🔴 Falls back to the default rather than to "everything". An unknown key means the colleague was
 * retired, renamed away, or the link is old; showing the whole graph instead would answer a question
 * about ONE colleague with everybody's memories, which is the exact confusion the partition exists
 * to prevent. The fallback is a different colleague's page, and the picker says whose.
 */
export const ownerFromKey = (
  owners: readonly MemoryOwner[],
  key: string | undefined,
): MemoryOwner | undefined => owners.find((owner) => owner.key === key) ?? defaultOwner(owners)

/** The link a colleague's own memory lives behind. ONE spelling, so the dialog that writes it and
 *  the page that reads it cannot drift. */
export const ownerRoute = (agentID: string): string => `/memory-graph?owner=${encodeURIComponent(`agent:${agentID}`)}`

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

/** How many of a colleague's memories are counted before the label gives up and says "200+". */
export const MEMORY_COUNT_CAP = 200

/**
 * The number to show beside the door, or `undefined` for no number at all.
 *
 * ⚠️ Zero shows NOTHING rather than "(0)". A colleague that has remembered nothing yet is the
 * ordinary state of a new hire, and a zero on a control reads as a fault report. At the cap the
 * label says `200+` — the list was capped, so any exact number past it would be invented.
 */
export const memoryCountLabel = (count: number | undefined): string | undefined =>
  count === undefined || count === 0 ? undefined : count >= MEMORY_COUNT_CAP ? `${MEMORY_COUNT_CAP}+` : String(count)
