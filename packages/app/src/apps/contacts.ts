// The Contacts roster — the presentation half of the named-agents programme (`notes/named-agents.md`,
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

import { AgentV2 } from "@novaclaw/core/agent"

/** The agent shape this module needs — a structural subset of `AgentV2.Info` so the view model can be
 *  tested without the wire type, and so a field added there does not force a change here. */
export interface AgentLike {
  readonly id: string
  readonly name?: string | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly personality?: string | undefined
  /** Who this officer reports to. Absent means Nova. */
  readonly superior?: string | undefined
  /** The standing brief. Not shown on a row — it can be pages long — but a CLONE must carry it, or
   *  the copy shares a job title with the original and none of its instructions. */
  readonly system?: string | undefined
  /** The model this colleague thinks with. Absent = it inherits the instance default. */
  readonly model?: { readonly providerID: string; readonly id: string } | undefined
  /** Set aside without being retired (config `disabled: true`). Still a colleague; may not act. */
  readonly paused?: boolean | undefined
  /**
   * The colleague's config fields, verbatim from the API row — everything `ConfigAgent.Info` declares
   * that this row actually had.
   *
   * 🔴 The typed fields above are what the ROSTER renders; this is what a CLONE copies, and the two
   * are different jobs. Measured 2026-08-21: both were hand-written lists, in series, and a clone
   * silently lost `steps` because the loader never carried it — after the clone's own list had already
   * been fixed to carry it. One hand-kept projection is a list that goes stale; two in a row is a list
   * that goes stale twice and blames the wrong file.
   */
  readonly config?: Record<string, unknown> | undefined
  readonly avatar?: string | undefined
  /** The colleague's own workspace — an absolute host path, derived server-side. Read-only. */
  readonly workspace?: string | undefined
  /**
   * What this colleague is currently working on, refreshed every few hours by the instance — the
   * line Contacts shows under the name, like a chat app's contact status.
   *
   * ⚠️ Absent means "nothing to say", not "idle". A colleague nobody has worked with has no task,
   * and a blank line where a sentence belongs is what "New session" was in the surface this replaces.
   */
  readonly status?: { readonly task: string; readonly observed: number } | undefined
  readonly memory?: "own" | "none" | undefined
  /** Keep compacted conversations in this colleague's own memory (default on). */
  readonly archiveChats?: boolean | undefined
  /** Whether the harness gives this colleague a final acceptance-check reminder. */
  readonly reground?: boolean | undefined
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
  /**
   * What this colleague is currently working on, derived by the instance every few hours.
   *
   * ⚠️ Distinct from `title` above, which is the ROLE ("Writer") and does not change. This is the
   * TASK, and changing is the whole point of it.
   */
  readonly status: { readonly task: string; readonly observed: number } | undefined
  readonly avatar: string | undefined
  readonly color: string | undefined
  /** `governing` is Nova: shown first, and refused by every delete door. */
  readonly kind: "governing" | "officer"
  /**
   * Set aside, not retired.
   *
   * ⚠️ A paused colleague is STILL LISTED, and in its usual place. Sorting it to the bottom or
   * dropping it would recreate the thing pausing was built to stop — a colleague you cannot see is a
   * colleague whose chat has no door. It is marked, not moved.
   */
  readonly paused: boolean
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

/** Valid choices for a reporting line. Descendants are excluded so Tune cannot author a cycle. */
export const superiorCandidates = (roster: readonly AgentLike[], selfID: string): readonly AgentLike[] => {
  const byID = new Map(roster.map((agent) => [agent.id, agent]))
  const reachesSelf = (candidate: AgentLike) => {
    const seen = new Set<string>()
    let current: AgentLike | undefined = candidate
    while (current?.superior && !seen.has(current.id)) {
      if (current.superior === selfID) return true
      seen.add(current.id)
      current = byID.get(current.superior)
    }
    return false
  }
  return roster.filter(
    (candidate) =>
      candidate.id !== selfID &&
      candidate.id !== GOVERNING_ID &&
      candidate.mode !== "subagent" &&
      !candidate.hidden &&
      candidate.paused !== true &&
      !reachesSelf(candidate),
  )
}

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

/**
 * The built-in agents that are POSTURES rather than people.
 *
 * 🔴 Owner, 2026-08-22: *"Build and Plan are the permission modes. Plan is just agent surveying the
 * project and then waiting user to confirm, while Build just proceeds to do work. They are per agent
 * switches."* The capability they name is `permissionMode`, which every colleague already carries in
 * its own config — so listing them beside Nova offered the same choice twice and dressed a setting up
 * as a person. The permission floor had said as much for weeks ("`build` and `plan` are the machinery
 * a person drives, not colleagues on the roster") while four surfaces went on showing them.
 *
 * ⚠️ Excluded HERE and not by marking them `hidden` in the agent plugin, which was tried first and
 * reverted. `hidden` also makes `AgentV2.selectedDefault` refuse them, so an unattributed chat would
 * fall to Nova — whose charter carries `colleague` and `spawn`. Every default session would then pay
 * for those schemas, and `httpapi-project-write-invalidates` (a 1 s cache window) went red on a whole
 * unit run: measured, not theorised. Who answers an unattributed chat is a separate product question
 * from who appears on the roster, and bundling them hid a real cost.
 */
/**
 * ⚠️ Re-exported from the KERNEL, not defined here. A kernel invariant now depends on the same
 * question — one chat per colleague, enforced at `createSessionRecord` — and two copies of
 * "is this a person?" drifting apart would mean the roster and the session store disagreeing about
 * who exists. `core/src/agent.ts` is the definition; this stays the name the app's four surfaces
 * import, so the choke point below is unchanged.
 */
export const POSTURE_AGENTS: ReadonlySet<string> = AgentV2.POSTURE_IDS

/**
 * Is this agent a colleague the user can talk to, rather than staff or machinery?
 *
 * ⚠️ ONE choke point on purpose: Contacts, the Memory owner picker, the Calendar's responsible-agent
 * picker and the composer's agent selector all reach the roster through here, and a rule enforced in
 * one of them is a rule the next surface gets wrong.
 */
export const isColleague = (agent: AgentLike): boolean => AgentV2.isColleague(agent)

const view = (agent: AgentLike): ContactView => {
  const governing = agent.id === GOVERNING_ID
  return {
    id: agent.id,
    name: agent.name?.trim() || displayName(agent.id),
    title: agent.title?.trim() || undefined,
    // Carried through verbatim: absent stays absent, so a colleague with no line yet renders without
    // one rather than with a blank where a sentence belongs.
    status: agent.status,
    avatar: agent.avatar?.trim() || undefined,
    color: agent.color,
    kind: governing ? "governing" : "officer",
    paused: agent.paused === true,
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

/**
 * The colleagues a user HID — the roster's second list, and the reason it exists.
 *
 * 🔴 `hidden: true` takes a row out of `roster()` (via `isColleague`) while leaving the colleague
 * fully able to act — unlike pausing, which denies it everything. Since the roster row is the only
 * door to a colleague's chat, hiding one produced a chat with NO door and an agent still running.
 * This is that door: the same shape as the Household row, at the foot of the list, visibly not one
 * of the working rows but openable.
 *
 * ⚠️ It deliberately does NOT return machinery. `hidden` is also the marker `plugin/agent.ts` sets on
 * `compaction`, `title` and the rest, and those are not colleagues anybody hid — surfacing them would
 * turn a "you hid these" list into an internals dump. The other two `isColleague` clauses still
 * apply, so what comes back is exactly *a colleague-shaped agent that is hidden*.
 */
export const hiddenRoster = (agents: readonly AgentLike[]): readonly ContactView[] =>
  agents
    .filter((agent) => agent.hidden === true && agent.mode !== "subagent" && !POSTURE_AGENTS.has(agent.id))
    .map(view)
    .sort((left, right) => left.name.localeCompare(right.name))

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
