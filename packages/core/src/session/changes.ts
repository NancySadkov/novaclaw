export * as SessionChanges from "./changes"

import type { Revert } from "@novaclaw/schema/revert"
import type { SessionMessage } from "./message"
import type { Session } from "@novaclaw/schema/session"

/**
 * The session-changes summary — what the app's "Changes" review and the chats changes badge
 * read from `SessionInfo.summary` (F1e re-pointed the review to the session RECORD; V1 wrote
 * per-user-message summary diffs that native transcripts don't carry, and nothing wrote the
 * record field until the runner's drain-end refresh landed with these helpers). Cumulative
 * semantics: the diff between the FIRST assistant `snapshot.start` and the LAST assistant
 * `snapshot.end` across the whole transcript. Pure — the runner owns the snapshot diff + the
 * record patch.
 */

export interface Boundaries {
  readonly from?: string
  readonly to?: string
}

/** Scan the full transcript (ascending) for the cumulative snapshot boundaries. */
export const boundaries = (messages: readonly SessionMessage.Message[]): Boundaries => {
  let from: string | undefined
  let to: string | undefined
  for (const message of messages) {
    if (message.type !== "assistant") continue
    if (from === undefined && message.snapshot?.start) from = message.snapshot.start
    if (message.snapshot?.end) to = message.snapshot.end
  }
  return { from, to }
}

type Summary = Session.ChangesSummary

/** Fold snapshot file diffs into the record's changes summary (counters + wire diffs). */
export const summary = (diffs: readonly Revert.FileDiff[]): Summary => ({
  additions: diffs.reduce((sum, item) => sum + item.additions, 0),
  deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
  files: diffs.length,
  diffs: diffs.map((item) => ({
    file: item.path as string,
    patch: item.patch,
    additions: item.additions,
    deletions: item.deletions,
    status: item.status,
  })),
})

/** Structural summary equality — the runner's dedup (skip the publish when nothing changed). */
export const equal = (a: Summary | undefined, b: Summary | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
