// The Contacts roster — the presentation half of the named-agents programme (`todo/named-agents.md`,
// and AGENTS.md → *the structural metaphor: the user is a shareholder, Nova is the CEO*).
//
// This module holds the decisions, so every one of them is testable and none of them lives inside a
// JSX branch:
//
//  1. **WHO is a colleague.** Sub-agents are the nameless staff an officer spawns for one piece of
//     work; hidden agents (compaction, title, summary) are machinery. Neither is someone you can
//     call, so neither belongs in an address book. A roster that lists every agent the kernel knows
//     is the session list again, wearing different words.
//  2. **Nova is first, and Nova is not deletable.** *"The charter is not editable from inside."*
//  3. **What each colleague remembers is stated in BOTH halves** — what is private to it AND what is
//     shared with everyone. The competitor's roster promises separation and shares the machine
//     underneath (`notes/survey/grokbot-research.md`); ours must not read the same way.

/** The agent shape this module needs — a structural subset of `AgentV2.Info` so the view model can be
 *  tested without the wire type, and so a field added there does not force a change here. */
export interface AgentLike {
  readonly id: string
  readonly name?: string | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly personality?: string | undefined
  readonly avatar?: string | undefined
  readonly memory?: "own" | "none" | undefined
  readonly mode: "primary" | "subagent" | "all"
  readonly hidden: boolean
  readonly color?: string | undefined
}

/** What the roster shows for one colleague. */
export interface ContactView {
  readonly id: string
  /** The name on the row. */
  readonly name: string
  /** The job line under the name — the role, not a summary of its prompt. */
  readonly title: string | undefined
  readonly avatar: string | undefined
  readonly color: string | undefined
  /** `governing` is Nova: shown first, and refused by every delete door. */
  readonly kind: "governing" | "officer"
  /** False for the governing agent — the roster must not offer a control the API will refuse. */
  readonly removable: boolean
  /** What this colleague remembers, as a key the page translates. Both halves, always. */
  readonly memory: "own" | "none"
}

/** The instance's governing agent. Mirrors `AgentV2.NOVA_ID`; kept as a literal here because the UI
 *  package must not import the kernel to render a list. `contacts.test.ts` pins the two together in
 *  spirit — if the kernel's id ever changes, the roster stops marking anyone as governing, which is
 *  visible rather than silent. */
export const GOVERNING_ID = "nova"

/** A slug is not a name. Agent ids are lowercase and hyphenated (`talent-scout`) because they are
 *  keys; the roster shows a person, so the row reads "Talent Scout".
 *
 *  This is the FALLBACK. A colleague normally carries a stored `name` — a Greek name drawn when Nova
 *  hires it (`core/src/agent/officer-name.ts`), which the user may then change. The id stays fixed
 *  because it keys the memory scope: renaming an id would orphan a colleague from everything it
 *  remembers. So the two exist for different reasons rather than by accident, and the stored name
 *  always wins. */
export const displayName = (id: string): string =>
  id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || id

/** Is this agent a colleague the user can talk to, rather than staff or machinery? */
export const isColleague = (agent: AgentLike): boolean => agent.mode !== "subagent" && !agent.hidden

const view = (agent: AgentLike): ContactView => {
  const governing = agent.id === GOVERNING_ID
  return {
    id: agent.id,
    name: agent.name?.trim() || displayName(agent.id),
    title: agent.title?.trim() || undefined,
    avatar: agent.avatar?.trim() || undefined,
    color: agent.color,
    kind: governing ? "governing" : "officer",
    // The row offers no Retire control for Nova, and the API refuses it too. Both, on purpose: a
    // rule enforced only where it is displayed is a rule an agent's own config write walks around.
    removable: !governing,
    memory: agent.memory ?? "own",
  }
}

/** The roster, in the order it is shown: the CEO first, then colleagues by name. */
export const roster = (agents: readonly AgentLike[]): readonly ContactView[] =>
  agents
    .filter(isColleague)
    .map(view)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "governing" ? -1 : 1
      return left.name.localeCompare(right.name)
    })

/** Filter the roster by what the user typed. Matches the name, the job title and the id, because a
 *  user who knows a colleague by any of the three should find it by that one. */
export const searchRoster = (views: readonly ContactView[], query: string): readonly ContactView[] => {
  const needle = query.trim().toLowerCase()
  if (needle === "") return views
  return views.filter((item) =>
    [item.name, item.title ?? "", item.id].some((field) => field.toLowerCase().includes(needle)),
  )
}

/** The two sentences a row shows about memory. BOTH are always rendered: the first is what this
 *  colleague keeps to itself, the second is what every colleague can see. Naming only the first is
 *  how a roster promises an isolation it does not have. */
export interface MemoryDisclosure {
  readonly privateKey: "contacts.memory.own" | "contacts.memory.none"
  readonly sharedKey: "contacts.memory.shared"
}

export const memoryDisclosure = (memory: "own" | "none"): MemoryDisclosure => ({
  privateKey: memory === "none" ? "contacts.memory.none" : "contacts.memory.own",
  sharedKey: "contacts.memory.shared",
})
