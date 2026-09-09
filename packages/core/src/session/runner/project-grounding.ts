export * as ProjectGrounding from "./project-grounding"

import fs from "node:fs/promises"

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

/**
 * How many names the grounding message will carry, and what it says when there are more.
 *
 * Bounded because this rides a message, not a tool result: a folder of ten thousand files must cost
 * the same as a folder of ten. Past the cap the count is stated and `read`/`glob` remain the way to
 * see the rest — a truncated list that does not say it was truncated is the "silent cap" this repo's
 * own rule forbids.
 */
export const MAX_LISTED_ENTRIES = 40

/** One entry as the model sees it: a name, and whether it is a folder. */
export interface Entry {
  readonly name: string
  readonly directory: boolean
}

/**
 * 🔴 **Nothing in NovaClaw ever told the model what is IN the working folder** (measured 2026-08-20,
 * six-glyph corpus). `<env>` deliberately leaves the folder horizon to this module — see
 * `system-context/builtins.ts` — and this module rendered only the PATH. So, asked *"please describe
 * each glyph here"* with the folder as its working directory, Holo-3.1 never listed anything: it
 * invented the single filename `glyphs.png` **from the folder's own name**, failed to read it twice,
 * and then asked the user to describe the pictures in words.
 *
 * ⚠️ Two informational fixes were tried first and neither converted — the `read` description saying
 * the picture arrives, and the perception section's wording. That is the pattern this repo keeps
 * re-learning (jh §13.4): *the model never instruments voluntarily; the harness must supply the
 * horizon*. A listing is the horizon, so the harness carries it rather than asking for it.
 *
 * ⚠️ It is NOT a substitute for `glob`/`ls`: bounded, one level deep, no sizes. Enough to know which
 * files exist and what they are called, which is the fact the model was inventing.
 */
export const renderEntries = (entries: ReadonlyArray<Entry>, total: number): string[] => {
  if (entries.length === 0) return []
  const names = entries.map((entry) => (entry.directory ? `${entry.name}/` : entry.name))
  const hidden = total - entries.length
  return [
    `Files here (${total}): ${names.join(", ")}` +
      (hidden > 0 ? ` — and ${hidden} more not listed; use \`glob\` or \`read\` on the folder to see them.` : ""),
  ]
}

/** Short provider-only reminder: concrete enough to prevent writes in the wrong tree, no ceremony. */
export const render = (
  location: {
    readonly directory: string
    readonly root: string
    readonly vcs?: { readonly type: string }
  },
  /** What the folder holds, when the caller could read it. Absent leaves the message as it was. */
  listing?: { readonly entries: ReadonlyArray<Entry>; readonly total: number },
): string =>
  [
    `Current working folder: ${location.directory}`,
    ...(isInformativeRoot(location.root, location.directory) ? [`Project root: ${location.root}`] : []),
    ...(location.vcs?.type === "git" ? ["This project uses Git."] : []),
    ...(listing ? renderEntries(listing.entries, listing.total) : []),
    "Keep project writes inside the working folder unless the user explicitly approves a different location.",
  ].join("\n")

/**
 * Read the working folder, bounded, for `render`.
 *
 * ⚠️ Never throws: an unreadable or vanished folder yields `undefined` and the grounding message is
 * exactly what it was before this existed. A listing is an aid, and an aid that can fail a turn is a
 * liability — the same reasoning `budgetImages` uses for an absent cap.
 *
 * ⚠️ Sorted, so two runs of one folder produce the same message and the provider's prefix cache is
 * not invalidated by directory-order noise.
 */
export const readListing = async (
  directory: string,
  /**
   * How many entries to return. Defaults to the PROMPT's cap.
   *
   * ⚠️ The two callers want different things and conflating them cost a real limitation. The
   * grounding MESSAGE is bounded because every name costs prompt tokens on a message the model reads.
   * The set-completion check is internal, pays nothing per name, and needs to see the whole set it is
   * driving — measured 2026-08-20, it drove 40 of 40 only because this cap happened to equal the
   * request, and a request for the first 100 would have silently become 40.
   */
  limit: number = MAX_LISTED_ENTRIES,
): Promise<{ readonly entries: ReadonlyArray<Entry>; readonly total: number } | undefined> => {
  try {
    const found = await fs.readdir(directory, { withFileTypes: true })
    const entries = found
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { entries: entries.slice(0, Math.max(0, limit)), total: entries.length }
  } catch {
    return undefined
  }
}
