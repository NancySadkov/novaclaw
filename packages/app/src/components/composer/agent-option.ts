// WHO the prompt is for — the pure half of the composer's agent chip.
//
// ⚠️ A plain module, not part of `agent-control.tsx`, for a boring reason with a real cost: that file
// imports solid's client-only rendering APIs, so `bun test` cannot load it, and a rule about which
// colleague the chip ADDRESSES would only ever be checkable by reading the source. "Nothing selected"
// and "the first one" are different facts, and the chip must not silently address the wrong desk.

export type ComposerAgentOption = {
  readonly id: string
  readonly name: string
  readonly avatar?: string | undefined
  /** What this colleague works on, already resolved — its project, or its own workspace. */
  readonly folder: string
  /** True when `folder` is the colleague's own scratch rather than a project the user chose. */
  readonly ownScratch: boolean
}

export type ComposerAgentControlState = {
  readonly options: readonly ComposerAgentOption[]
  readonly selectedID: string | undefined
  /** Disabled mid-turn: switching who is answering while they are answering is a race, not a choice. */
  readonly working: boolean
  /**
   * IDENTITY, not a picker — the shape the chip takes inside an existing chat.
   *
   * 🔴 A chat belongs to ONE colleague (owner: "a single compactable chat per agent"), so a
   * mid-conversation agent switch would hand somebody else's transcript to a different officer —
   * exactly the confusion the roster removed. In a chat the question "who is this for" is already
   * answered; the chip says who, and changing who works on something happens in Contacts.
   */
  readonly readOnly?: boolean | undefined
  readonly onSelect: (id: string) => void
  /**
   * Open this colleague's configuration — what the retired "Tune" button used to do.
   *
   * Absent on HOME, where the chip is a real selector and a click must open the picker rather than a
   * settings dialog. Present in a chat, where the chip was inert and the owner asked for it to become
   * the door (2026-08-27).
   */
  readonly onOpenConfig?: (() => void) | undefined
  /**
   * Assign the colleague a PROJECT, from the composer (owner, 2026-08-28: *"the project picker should
   * really be moved to the chat, and placed after the agent's name, so user always sees what project
   * this agent is working on"*).
   *
   * 🔴 It lived only inside Tune, three sections down a scrolling dialog, so the answer to "what is
   * this colleague working on right now" cost a dialog open and a scroll — while the composer, which
   * is on screen the whole conversation, had the answer already resolved and did not show it.
   *
   * ⚠️ Absent on HOME, where the chip is a selector: a click there must open the picker of WHO, and a
   * second meaning on the same control is how a chip stops being predictable.
   */
  readonly onPickProject?: (() => void) | undefined
  /** The unattended-mode suffix, inherited from the trigger this chip replaced — it says what the
   *  agent may do without you, so it follows the control the user actually presses. */
  readonly modeSuffix?: (() => string) | undefined
  readonly unattended?: (() => boolean) | undefined
}

/**
 * The colleague currently selected — **or the first one**, never nothing while a roster exists.
 *
 * ⚠️ It returns `undefined` only when `options` is EMPTY, not "while the roster is loading". An
 * unmatched `selectedID` falls back to `options[0]`, deliberately: a stale id (a retired colleague,
 * a restored session) must not leave the composer with no agent, which is the shape that renders a
 * disabled control the user cannot explain.
 */
export const selectedOption = (state: ComposerAgentControlState): ComposerAgentOption | undefined =>
  state.options.find((option) => option.id === state.selectedID) ?? state.options[0]
