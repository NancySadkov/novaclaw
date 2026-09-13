export type SessionProviderRecovery = {
  attemptID: string
  toolProtocol: boolean
}

export function visibleProviderRecovery(input: {
  recovery: SessionProviderRecovery | undefined
  working: boolean
  stopped: boolean
  dismissedAttemptID: string | undefined
}) {
  if (input.working || input.stopped) return
  if (!input.recovery || input.dismissedAttemptID === input.recovery.attemptID) return
  return input.recovery
}
