type CommandKeybind = {
  keybindParts: (id: string) => string[]
}

export function reviewTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("review.toggle")
}

// newTabTooltipKeybind died with the legacy titlebar "+" (owner 2026-07-22): chat creation
// lives in the launcher bar and the Chats page's New Session button.
