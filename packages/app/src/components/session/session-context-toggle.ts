export type SessionContextAction = "close-tab" | "open-panel"

/**
 * The Context tab may remain active while its containing panel is closed. In that state the first
 * gauge click must reopen the panel, not close the invisible tab and make the user click twice.
 */
export const sessionContextAction = (input: {
  readonly panelOpened: boolean
  readonly activeTab: string
}): SessionContextAction => (input.panelOpened && input.activeTab === "context" ? "close-tab" : "open-panel")
