type ModelKey = { providerID: string; modelID: string; variant?: string }

// The composer model/agent seed. Native user messages carry no agent/model, so the caller
// sources these from the session record (`info()`); this is the shape `local.session.restore` needs.
export type SessionModelSeed = { sessionID: string; agent: string; model: ModelKey }

type Local = {
  session: {
    reset(): void
    restore(msg: SessionModelSeed): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, seed: SessionModelSeed) => {
  local.session.restore(seed)
}
