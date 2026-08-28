export * as CredentialRepair from "./repair"

import { Effect } from "effect"

/**
 * Which stored secrets cannot be read, and what the user has to do about it.
 *
 * 🔴 NC-REL-030(b) — the user-facing half. An instance whose `credential.key` was lost in a partial
 * restore now BOOTS (that was (a)); every unreadable secret is skipped and fails closed. What was
 * missing is anywhere that SAYS so. Failing closed silently means a user watching a provider
 * mysteriously not authenticate, with the actual cause — one missing file next to the database —
 * visible only in a log they have no reason to open.
 *
 * ⚠️ A PULL, not a push. The three read paths that meet this fault (`credential.ts`,
 * `settings-config-store.ts`, `mcp/auth.ts`) each log and skip, and threading a notification service
 * through all three would put a UI concern inside three storage modules — and would still only
 * report the secrets something happened to read this boot. The condition is a property of what is
 * STORED, so asking directly answers for every row rather than for the touched ones.
 *
 * ⚠️ It reports paths, never values. A sealed value is unreadable by definition here, but the id it
 * is stored under is not, and a notice that quoted stored bytes would be one that leaks them the day
 * this runs against something readable.
 */

/** One stored secret that cannot be opened. `path` is its stable id, e.g. `credential:anthropic`. */
export type Unreadable = { readonly path: string }

export type ScanSource = {
  /** Every stored value that might be sealed, with the id to report it under. */
  readonly rows: () => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly value: unknown }>>
  /** Whether a stored value is an envelope at all — a plaintext row is not a fault. */
  readonly sealed: (value: unknown) => boolean
  /** Attempt to open it. The error channel is the answer; the plaintext is deliberately discarded. */
  readonly open: (path: string, value: unknown) => Effect.Effect<unknown, unknown>
}

const NONE: ReadonlyArray<Unreadable> = []

/**
 * Every unreadable secret in one source.
 *
 * ⚠️ A source that FAILS to list its rows contributes nothing and does not fail the scan. This runs
 * to tell a user that something is broken, against exactly the stores that may be damaged; a scan
 * that dies when one of them does becomes a second broken thing and reports nothing at all —
 * including what the healthy sources found.
 */
export const scanSource = (source: ScanSource): Effect.Effect<ReadonlyArray<Unreadable>> =>
  source.rows().pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.filter((row) => source.sealed(row.value)),
        (row) =>
          source.open(row.path, row.value).pipe(
            Effect.as(NONE),
            Effect.catchCause(() => Effect.succeed<ReadonlyArray<Unreadable>>([{ path: row.path }])),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.map((found) => found.flat()),
    Effect.catchCause(() => Effect.succeed(NONE)),
  )

export const scan = (sources: ReadonlyArray<ScanSource>): Effect.Effect<ReadonlyArray<Unreadable>> =>
  Effect.forEach(sources, scanSource, { concurrency: 1 }).pipe(
    Effect.map((all) => {
      // ⚠️ Deduped by path. The same secret can be reachable through more than one store while the
      // cipher unwind moves rows between them, and counting it twice overstates the damage in the
      // one message a user reads to decide whether to restore a backup.
      const seen = new Set<string>()
      return all.flat().filter((item) => {
        if (seen.has(item.path)) return false
        seen.add(item.path)
        return true
      })
    }),
  )

/** The file whose loss causes every one of these, named so the notice can say what to restore. */
export const KEY_FILE = "credential.key"

/**
 * What to tell the user. Returns `undefined` when there is nothing wrong — a notice surface must be
 * able to ask unconditionally and render nothing.
 *
 * ⚠️ It names the FILE and the DIRECTORY. "Some credentials could not be read" is a statement of
 * symptom that leaves the user nowhere to go; the entire repair is restoring one file, and a message
 * that does not name it makes a fixable state look like data loss.
 */
export function notice(unreadable: ReadonlyArray<Unreadable>, directory: string): string | undefined {
  if (unreadable.length === 0) return undefined
  const count = unreadable.length === 1 ? "1 stored secret" : `${unreadable.length} stored secrets`
  return (
    `${count} cannot be read, so anything using them will fail to authenticate. ` +
    `They were encrypted with "${KEY_FILE}", which is missing or unreadable in ${directory}. ` +
    `Restoring that file from a backup repairs them; there is no way to recover them without it.`
  )
}
