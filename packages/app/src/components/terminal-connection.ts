export type TerminalConnectFailure = {
  kind: "gone" | "blocked" | "unavailable"
  error: unknown
}

export const terminalConnectFailureMessage = (failure: TerminalConnectFailure, fallback: string) =>
  failure.error instanceof Error && failure.error.message ? failure.error.message : fallback

/** A replacement PTY is safe only after the server has confirmed the old process no longer exists. */
export const shouldCloneTerminal = (failure: TerminalConnectFailure) => failure.kind === "gone"
