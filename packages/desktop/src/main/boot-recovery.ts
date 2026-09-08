/**
 * What the user is OFFERED when the local server refuses to start.
 *
 * 🔴 NC-REL-024 / NC-REL-030 — the Recovery surface, first real piece.
 *
 * The database layer classifies its own faults, writes a non-developer sentence and a concrete
 * repair list, and `describeSidecarFailure` picks all of that up. Until now the consumer LOGGED it
 * and returned: a user whose database came from a newer NovaClaw — an ordinary thing after a
 * downgrade — got a window that never appeared and a log file they were never told about. The
 * classification was built, tested, and never shown to anybody.
 *
 * ⚠️ This is deliberately not a "Recovery mode". A second UI that boots without the primary database
 * is a large surface with its own failure modes, and the one thing that actually unbricks an
 * instance is a single reversible action. That is what this offers.
 *
 * ⚠️ Move ASIDE, never delete. AGENTS.md's product ethos is that it never breaks in your hands, and
 * a button that deletes the user's only copy of their work would be the opposite even when the file
 * is unreadable — unreadable by THIS build is not unreadable forever, and a foreign database is
 * somebody's working instance. The file is renamed, in place, and the name says what happened.
 */

/** The actions a boot failure can offer, in the order they are presented. */
export type RecoveryAction = "move-aside" | "open-folder" | "export-logs" | "quit"

export type RecoveryChoice = {
  readonly label: string
  readonly action: RecoveryAction
}

/**
 * ⚠️ Offered ONLY when a database path is known. Without one, "move the database aside" is a button
 * that cannot say which file it means — and the failure might not be about a database at all.
 */
export function recoveryChoices(databasePath: string | undefined): readonly RecoveryChoice[] {
  const choices: RecoveryChoice[] = []
  if (databasePath !== undefined) choices.push({ label: "Move database aside and restart", action: "move-aside" })
  // ⚠️ Also gated on the path. Without one there is no folder this button could honestly open, and
  // sending the user to the log directory instead would have them believe they had looked at the
  // right place.
  if (databasePath !== undefined) choices.push({ label: "Open containing folder", action: "open-folder" })
  choices.push({ label: "Export logs", action: "export-logs" })
  choices.push({ label: "Quit", action: "quit" })
  return choices
}

/**
 * Where an unusable database file is moved to.
 *
 * ⚠️ The timestamp is passed in rather than read here, so the name is a function of its inputs and
 * a test can assert the whole string. Colons are stripped because Windows filenames cannot carry
 * them — an ISO timestamp used verbatim produces a rename that fails on the platform this app
 * mainly ships to, and it would fail at exactly the moment the user is already stuck.
 */
export function movedAsidePath(databasePath: string, isoTimestamp: string): string {
  const stamp = isoTimestamp.replace(/[:.]/g, "-")
  return `${databasePath}.unusable-${stamp}`
}

/**
 * The sentence shown after the move succeeds.
 *
 * It names the file, because the next thing a user who cared about that data will do is look for
 * it, and a rename they cannot find reads as a deletion.
 */
export function movedAsideNotice(target: string): string {
  return `The unreadable database was renamed to ${target}. Nothing was deleted — NovaClaw will start with a new one.`
}
