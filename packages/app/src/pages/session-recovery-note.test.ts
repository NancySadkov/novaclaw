import { describe, expect, test } from "bun:test"
import { recoveryChangesNote } from "./session-recovery-note"

describe("what the recovery banner says about the workspace", () => {
  test("a finished recording states the count plainly", () => {
    expect(recoveryChangesNote({ files: 3, complete: true })).toBe("3 files changed.")
    expect(recoveryChangesNote({ files: 1, complete: true })).toBe("1 file changed.")
    expect(recoveryChangesNote({ files: 0, complete: true })).toBe("No files changed.")
  })

  test("an unfinished recording reports a FLOOR, never a total", () => {
    // `markChangesIncomplete` sets complete:false at drain entry, so a crashed turn's count is
    // whatever had been recorded when it stopped. Presenting that as the total would understate
    // what happened to the workspace.
    expect(recoveryChangesNote({ files: 2, complete: false })).toBe(
      "At least 2 files changed — the recording did not finish, so there may be more.",
    )
  })

  /**
   * ⚠️ THE case this module exists for. Zero changes with an unfinished recording does NOT mean
   * nothing happened — it means we never got far enough to know. Saying "No files changed" here
   * would be a false reassurance at the exact moment someone decides whether to re-run a
   * non-idempotent effect, which is the most expensive place in the product to be wrong.
   */
  test("zero-and-incomplete never reads as 'nothing happened'", () => {
    const note = recoveryChangesNote({ files: 0, complete: false })
    expect(note).toBe("Nova was still recording what changed, so some work may have happened.")
    expect(note).not.toContain("No files changed")
  })

  test("an absent summary says nothing rather than guessing", () => {
    // A session with no recording at all is not a session with no changes.
    expect(recoveryChangesNote(undefined)).toBe("")
  })

  test("a missing `complete` flag is treated as a finished recording", () => {
    // Older rows predate the flag; they were written by turns that completed, so the count is real.
    expect(recoveryChangesNote({ files: 4 })).toBe("4 files changed.")
  })
})
