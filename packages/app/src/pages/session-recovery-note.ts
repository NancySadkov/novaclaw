/**
 * What the recovery banner says about the WORKSPACE after an interrupted turn.
 *
 * The session-recovery gate wants the transcript UI to explain retry, stop, reconcile and
 * **changed files** without model assistance. The banner already explained retry and stop; this is
 * the changed-files half, and it is the one that decides whether retrying is safe — a failure class
 * tells you what broke, not what it did to your files first.
 *
 * ## `complete` rules every branch
 *
 * `markChangesIncomplete` sets `complete: false` at drain ENTRY, before anything can touch the
 * workspace, and only a finished turn refreshes it. So on an interrupted turn the count is a FLOOR,
 * never a total, and the wording must not imply otherwise.
 *
 * ⚠️ **The dangerous branch is zero-and-incomplete.** "No files changed" there would be a false
 * reassurance at exactly the moment someone is deciding whether to re-run a side effect — the
 * recording simply never got far enough to say. It reports that instead, which is ruling 2 applied
 * to the one screen where being wrong costs the user real work.
 */
export interface ChangesSummaryLike {
  readonly files?: number
  /** `false` = the recording was still open when the turn stopped. */
  readonly complete?: boolean
}

export const recoveryChangesNote = (summary: ChangesSummaryLike | undefined): string => {
  if (!summary) return ""
  const files = summary.files ?? 0
  const plural = files === 1 ? "" : "s"
  if (summary.complete === false)
    return files === 0
      ? "Nova was still recording what changed, so some work may have happened."
      : `At least ${files} file${plural} changed — the recording did not finish, so there may be more.`
  return files === 0 ? "No files changed." : `${files} file${plural} changed.`
}
