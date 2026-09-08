// WHAT A CHAT TAB IS CALLED (owner, 2026-08-23: *"the Chat tabs should have agent names, instead of
// titles"*).
//
// 🔴 **The tab names WHO, not WHAT.** A tab strip full of auto-generated topics — "Fix the parser
// crash", "Refactor the exporter" — is the chat list this product replaced, wearing a different
// shape: it asks the user to remember which of five topics they were talking to whom about. Under
// the roster the colleague is the unit (AGENTS.md → *the structural metaphor*), so the tab says
// "Iris" and the topic moves to the tooltip, where it costs nothing until you want it.
//
// ⚠️ **The fallback is the session title, and it is not dead code.** A chat can have no colleague at
// all: a session created before the roster existed, one spawned by an integration, or a sub-agent
// thread opened directly. Naming those after nobody would be worse than naming them after their
// topic, so they keep the title.
//
// Pure so `bun test` can reach it — the tab strip itself is a `.tsx` the unit tier cannot load, and
// that is precisely how the defects in this area have historically survived.

/** The subset of an agent record this needs. Structural, so the wire type may grow freely. */
export interface TabAgentLike {
  readonly id: string
  readonly name?: string | undefined
}

/** Title-case an agent id the way the roster does, for a colleague whose record carries no name. */
export const idToName = (id: string): string =>
  id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || id

export interface TabLabel {
  /** What the tab shows. */
  readonly text: string
  /** What the tab's tooltip shows — the chat's own topic, when it has one and it is not the text. */
  readonly tooltip: string | undefined
  /**
   * True when `text` is the chat's own title rather than a colleague's name.
   *
   * ⚠️ The rename gesture keys on this. Double-clicking a tab edits the SESSION TITLE, so offering
   * it on a tab that displays a colleague's name would let the user type a new name, press Enter,
   * and watch the tab snap back to the old one — a control that appears to work and does not. A
   * colleague is renamed in its own config, which is the one place that write belongs.
   */
  readonly renameable: boolean
}

/**
 * The label for one chat tab.
 *
 * `agents` is the instance's agent list as the client already holds it (`sync().data.agent`). An id
 * that is not in it still yields a name — a roster that has not loaded yet, or a colleague retired
 * while its chat stayed open, must not blank the tab.
 */
export function tabLabel(input: {
  readonly agent: string | undefined
  readonly title: string | undefined
  readonly agents: readonly TabAgentLike[]
}): TabLabel {
  const title = input.title?.trim()
  const agentID = input.agent?.trim()
  if (!agentID) return { text: title ?? "", tooltip: undefined, renameable: true }
  const record = input.agents.find((entry) => entry.id === agentID)
  const name = record?.name?.trim() || idToName(agentID)
  return {
    text: name,
    // Only when it says something the label does not. An auto-title that happens to equal the
    // colleague's name (which is what `startChat` writes for a colleague's first chat) would
    // otherwise show a tooltip repeating the tab.
    tooltip: title && title !== name ? title : undefined,
    renameable: false,
  }
}
