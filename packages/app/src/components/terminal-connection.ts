export type TerminalConnectFailure = {
  kind: "gone" | "blocked" | "unavailable"
  error: unknown
}

export type TerminalPresence = "present" | "gone" | "unavailable"

/** Classify the post-disconnect probe without treating transport failure as proof the PTY exists. */
export const terminalPresenceFromStatus = (status: number | undefined): TerminalPresence => {
  if (status === undefined) return "unavailable"
  if (status === 404) return "gone"
  return status >= 200 && status < 300 ? "present" : "unavailable"
}

export const terminalConnectFailureMessage = (failure: TerminalConnectFailure, fallback: string) =>
  failure.error instanceof Error && failure.error.message ? failure.error.message : fallback

/** A replacement PTY is safe only after the server has confirmed the old process no longer exists. */
export const shouldCloneTerminal = (failure: TerminalConnectFailure) => failure.kind === "gone"
