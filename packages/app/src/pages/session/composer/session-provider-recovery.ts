export type SessionProviderRecovery = {
  attemptID: string
  toolProtocol: boolean
}

export function visibleProviderRecovery(input: {
  recovery: SessionProviderRecovery | undefined
  working: boolean
  dismissedAttemptID: string | undefined
}) {
  if (input.working) return
  if (!input.recovery || input.dismissedAttemptID === input.recovery.attemptID) return
  return input.recovery
}
