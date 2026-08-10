export * as ProjectGrounding from "./project-grounding"

export const TOKEN_INTERVAL = 64 * 1024

export interface State {
  readonly directory: string
  readonly compactionID?: string
  readonly tokenAnchor: number
}

export interface Decision {
  readonly due: boolean
  readonly state?: State
}

/**
 * Decide whether the model needs a fresh location horizon.
 *
 * State is deliberately a bounded in-memory delivery latch, not session truth. Restarting may repeat
 * one grounding message; persisting it in the transcript would make every later provider payload pay
 * for every old reminder. Compaction resets the token anchor because the model received a new context
 * epoch, while an exact 64K increase advances the anchor without drifting with oversized turns.
 */
export const decide = (
  input: {
    readonly enabled: boolean
    readonly directory: string
    readonly compactionID?: string
    readonly contextTokens: number
  },
  previous: State | undefined,
): Decision => {
  if (!input.enabled) return { due: false }

  const contextTokens = Math.max(0, Math.floor(input.contextTokens))
  if (previous === undefined || previous.directory !== input.directory) {
    return {
      due: true,
      state: {
        directory: input.directory,
        ...(input.compactionID === undefined ? {} : { compactionID: input.compactionID }),
        tokenAnchor: contextTokens,
      },
    }
  }

  if (input.compactionID !== undefined && input.compactionID !== previous.compactionID) {
    return {
      due: true,
      state: { directory: input.directory, compactionID: input.compactionID, tokenAnchor: contextTokens },
    }
  }

  if (contextTokens - previous.tokenAnchor >= TOKEN_INTERVAL) {
    const intervals = Math.floor((contextTokens - previous.tokenAnchor) / TOKEN_INTERVAL)
    return {
      due: true,
      state: { ...previous, tokenAnchor: previous.tokenAnchor + intervals * TOKEN_INTERVAL },
    }
  }

  return { due: false, state: previous }
}

export const isInformativeRoot = (root: string, directory: string): boolean => {
  if (root === directory) return false
  const normalized = root.replace(/[\\/]+$/, "")
  return normalized !== "" && !/^[A-Za-z]:$/.test(normalized)
}

/** Short provider-only reminder: concrete enough to prevent writes in the wrong tree, no ceremony. */
export const render = (location: {
  readonly directory: string
  readonly root: string
  readonly vcs?: { readonly type: string }
}): string =>
  [
    `Current working folder: ${location.directory}`,
    ...(isInformativeRoot(location.root, location.directory) ? [`Project root: ${location.root}`] : []),
    ...(location.vcs?.type === "git" ? ["This project uses Git."] : []),
    "Keep project writes inside the working folder unless the user explicitly approves a different location.",
  ].join("\n")
