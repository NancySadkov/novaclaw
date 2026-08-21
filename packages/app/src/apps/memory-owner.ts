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
  readonly avatar: string | undefined
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
      avatar: view.avatar,
      // A colleague's OWN cabinet only. Deliberately not `agent:<id>` ∪ `global`, even though that is
      // what its turns read: this view answers "what does Trader know that nobody else does", and
      // folding the household's facts into every colleague's page would make all of them look
      // identical and hide the very partition the roster promises.
      scopes: [`agent:${view.id}`],
      kind: "agent",
    }),
  ),
  { key: SHARED_KEY, label: sharedLabel, avatar: undefined, scopes: ["global"], kind: "shared" },
]

/** The owner to show when the app opens, or `undefined` when there is nobody at all. Nova first,
 *  because the CEO is the colleague every instance has and the one a new user has already met. */
export const defaultOwner = (owners: readonly MemoryOwner[]): MemoryOwner | undefined => owners[0]

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
