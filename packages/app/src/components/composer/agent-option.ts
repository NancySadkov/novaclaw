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
  readonly onSelect: (id: string) => void
}

/** The colleague currently selected, or undefined while the roster is still loading. */
export const selectedOption = (state: ComposerAgentControlState): ComposerAgentOption | undefined =>
  state.options.find((option) => option.id === state.selectedID) ?? state.options[0]
