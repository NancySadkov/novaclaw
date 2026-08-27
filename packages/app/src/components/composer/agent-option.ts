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
  /** The unattended-mode suffix, inherited from the trigger this chip replaced — it says what the
   *  agent may do without you, so it follows the control the user actually presses. */
  readonly modeSuffix?: (() => string) | undefined
  readonly unattended?: (() => boolean) | undefined
}

/** The colleague currently selected, or undefined while the roster is still loading. */
export const selectedOption = (state: ComposerAgentControlState): ComposerAgentOption | undefined =>
  state.options.find((option) => option.id === state.selectedID) ?? state.options[0]
