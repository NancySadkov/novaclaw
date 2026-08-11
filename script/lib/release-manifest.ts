import type { Digest } from "./release-hashes"

/**
 * The rollback manifest — what a user needs to get the previous version back.
 *
 * Last of the four artifact gaps in `doc/release.md`. Today "roll back" means "find the old download
 * yourself", which on a portable build is the only recovery path there is: the app does not
 * self-update into the archive, so a release that breaks for someone leaves them hunting a URL.
 * *It never breaks in your hands* is not satisfied by a working install; it is satisfied by a way
 * back when the install does not work.
 *
 * ## Append-only, and why that is the whole design
 *
 * A rollback manifest that can LOSE an entry is worse than none: the version a user needs is
 * precisely the one that is no longer current, so history is the payload rather than a nicety.
 * `addRelease` therefore refuses to overwrite an existing version, and the shape carries no
 * operation that removes one.
 */
export interface ReleaseEntry {
  readonly version: string
  /** ISO 8601. Stamped by the caller — a module that reads the clock cannot be tested. */
  readonly released: string
  /** The version this one replaced, or `null` for the first ever recorded. */
  readonly supersedes: string | null
  readonly artifacts: readonly Digest[]
}

export interface Manifest {
  readonly schema: 1
  /** Newest FIRST — the order a download page renders, so no consumer has to sort. */
  readonly releases: readonly ReleaseEntry[]
}

export const EMPTY: Manifest = { schema: 1, releases: [] }

export function addRelease(
  manifest: Manifest,
  input: { readonly version: string; readonly released: string; readonly artifacts: readonly Digest[] },
): Manifest {
  if (input.artifacts.length === 0)
    throw new Error(`refusing to record ${input.version} with no artifacts — an entry nobody can download`)
  const clash = manifest.releases.find((r) => r.version === input.version)
  if (clash)
    throw new Error(
      `${input.version} is already recorded (released ${clash.released}). The manifest is append-only: ` +
        `a rollback target that can be rewritten is not a rollback target.`,
    )
  const entry: ReleaseEntry = {
    version: input.version,
    released: input.released,
    // The PREVIOUS newest, not "the version before this one by number". A hotfix released after a
    // higher version still supersedes what people actually had.
    supersedes: manifest.releases[0]?.version ?? null,
    artifacts: [...input.artifacts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }
  return { schema: 1, releases: [entry, ...manifest.releases] }
}

/** The entry a user on `version` should roll back TO, or undefined if there is nowhere to go. */
export function rollbackTargetFor(manifest: Manifest, version: string): ReleaseEntry | undefined {
  const index = manifest.releases.findIndex((r) => r.version === version)
  if (index < 0) return undefined
  return manifest.releases[index + 1]
}

export function render(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n"
}
