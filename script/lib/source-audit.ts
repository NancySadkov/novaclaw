/**
 * Audits the file list of a SOURCE drop before it is allowed to be called a release.
 *
 * 🔴 The class this closes: **a check whose negative branches pass when it read nothing.** The batch
 * version of this audit piped an archive listing into four `findstr` guards — two "must be here" and
 * two "must never be here". When the listing came out empty, which is exactly what happens when the
 * listing command itself fails, the two forbidden-content guards passed on the strength of having
 * seen nothing at all. A source drop full of `node_modules` would have sailed through, and the only
 * reason it did not was an unrelated exit-code check sitting one line above.
 *
 * So emptiness is a FAILURE here, not a pass, and it is said in those words. A verification that
 * cannot tell "clean" from "unread" is not a verification.
 *
 * The listing is produced by the caller, which passes the archiver that the resolver PROBED — the
 * same binary that wrote the archive. Naming `tar` and letting PATH decide was the original defect:
 * on a box with Git for Windows installed that resolves to GNU tar, which reads the `C:` of an
 * absolute Windows path as a remote-host spec and dies with `Cannot connect to C: resolve failed`.
 */

export type SourceAudit = {
  readonly ok: boolean
  /** What is wrong, one line each, phrased for a person reading a build log at release time. */
  readonly problems: readonly string[]
  /** How many entries were actually examined. Zero of these is never a pass. */
  readonly entries: number
}

/** Every one must be present in the source drop: attribution, manifest, and bundled Git source offer. */
export const REQUIRED_ENTRIES = ["NOTICE", "package.json", "licenses/portable-git-NOTICE.md"] as const

/** Content classes that must never reach a source drop, however tidy the rest of it looks. */
export const FORBIDDEN_MARKERS = ["/node_modules/", "/.git/", "/tmp/"] as const

/**
 * @param listing One path per line, as `tar -tf` prints it.
 * @param root    The prefix `git archive --prefix` gave every entry, e.g. `NovaClaw-0.1.75-source`.
 */
export function auditSourceListing(listing: string, root: string): SourceAudit {
  const entries = listing
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ""))
    .filter((line) => line.length > 0)

  if (entries.length === 0) {
    return {
      ok: false,
      entries: 0,
      problems: [
        "the archive listing is EMPTY — the archive was never read, so nothing about its contents is verified",
      ],
    }
  }

  const problems: string[] = []
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(`${root}/${required}`)) problems.push(`missing required entry: ${root}/${required}`)
  }
  for (const marker of FORBIDDEN_MARKERS) {
    const hit = entries.find((entry) => entry.includes(marker))
    if (hit !== undefined) problems.push(`forbidden content (${marker}) in a source drop: ${hit}`)
  }
  return { ok: problems.length === 0, problems, entries: entries.length }
}
