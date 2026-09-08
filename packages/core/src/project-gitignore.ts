export * as ProjectGitignore from "./project-gitignore"

import { ProjectExclusion } from "./project-exclusion"

/**
 * Turn a `.gitignore` into a SUGGESTION for `novaclaw.json`'s `exclude` list.
 *
 * *"`.gitignore` import and writing the exclusion section back"*, under the standing rule that
 * *"read eligibility stays distinct from watcher/build ignores."*
 *
 * 🔴 **A `.gitignore` and a "never read" list are two different statements, and this module never
 * pretends otherwise.** `.gitignore` answers *"what should not be committed"* — build output, a
 * `node_modules`, a local `.env`. `exclude` answers *"what must never reach a model"*. The overlap is
 * real (the `.env` belongs on both) and so is the disagreement (`dist/` is fine to read, and a
 * secrets folder that IS committed is not in the `.gitignore` at all). So this is an import, never a
 * sync: it produces candidates a person confirms, one screen away from the file they came from, and
 * nothing here writes anything or re-runs later.
 *
 * 🔴 **Every candidate is checked against the matcher that will actually honour it.**
 * `ProjectExclusion.ruleFor` is the one implementation of the pattern semantics, and this module
 * asks it rather than re-deriving them. A suggestion listing a line the matcher discards would be
 * the same defect the `exclude` section itself had before 2026-08-18 — a promise with nothing
 * underneath — so a line the matcher will not honour is REPORTED as dropped, never quietly omitted.
 *
 * ⚠️ **Only the project root's own `.gitignore`.** git reads one per directory and composes them;
 * `exclude` patterns are relative to the folder holding the `novaclaw.json`, so importing a nested
 * `.gitignore` would need every line re-anchored, and a re-anchored line is no longer the line the
 * user can recognise in their own file. The surface says which file it read.
 */

/** Why a `.gitignore` line produced no pattern. Blank lines and comments are not dropped — they are nothing. */
export type DropReason =
  /**
   * The line uses `\` — which is gitignore's ESCAPE character and this module's PATH SEPARATOR.
   *
   * 🔴 The two readings are irreconcilable and the disagreement is silent, which is why the line is
   * dropped rather than guessed at. `foo\ ` in a `.gitignore` means the file `foo ` (a trailing
   * space, escaped so git keeps it); fed to `ruleFor` it becomes `foo/ `, is trimmed to `foo/`, and
   * ends up meaning *the directory `foo`* — a different, real, probably-important directory. There
   * is no way to tell that case from a Windows user typing `build\out` by looking at the line, so
   * neither reading may be applied on the user's behalf.
   */
  | "escape"
  /** `ruleFor` refused it: it normalises to nothing, or it climbs above the project root (`../x`). */
  | "outside-root"

export interface Dropped {
  /** The line as it appeared, so the surface can quote it back. */
  readonly source: string
  readonly reason: DropReason
}

export interface Proposal {
  /** Patterns to APPEND, in file order, already de-duplicated against `existing` and each other. */
  readonly add: readonly string[]
  /** Lines that are already in the project's `exclude` list. Named so "nothing to add" is explainable. */
  readonly already: readonly string[]
  /** Lines this build cannot honour, with the reason. Reported rather than silently skipped. */
  readonly dropped: readonly Dropped[]
  /**
   * The subset of `add` that RE-INCLUDES (`!foo`).
   *
   * ⚠️ Surfaced separately because appending is not neutral for these: the last matching pattern
   * wins, so an imported `!important.log` lands AFTER — and therefore overrides — an exclusion the
   * user wrote by hand. That is a real widening of what the model may read, produced by a file the
   * user did not write with this in mind, and it must be visible before they press the button.
   */
  readonly reincludes: readonly string[]
}

export const EMPTY_PROPOSAL: Proposal = { add: [], already: [], dropped: [], reincludes: [] }

/**
 * A ceiling on how much of a `.gitignore` becomes a proposal.
 *
 * Not a safety boundary — a huge generated `.gitignore` is ordinary, and a confirmation dialog
 * listing 900 patterns is one nobody reads, which turns a confirmed suggestion back into a silent
 * sync. Truncation is reported by the caller, never hidden.
 */
export const MAX_CANDIDATES = 200

/**
 * The largest `.gitignore` this reads at all, in bytes.
 *
 * A `.gitignore` is a hand-maintained text file; anything past this is not one, and the route that
 * calls this runs on every settings load.
 */
export const MAX_BYTES = 256 * 1024

/**
 * Read a `.gitignore`'s text against a project's current `exclude` list.
 *
 * @param text the `.gitignore`, verbatim
 * @param existing the project's current `exclude` patterns
 */
export function propose(text: string, existing: readonly string[]): Proposal {
  const have = new Set(existing.map((pattern) => pattern.trim()))
  const add: string[] = []
  const already: string[] = []
  const dropped: Dropped[] = []
  const reincludes: string[] = []
  const seen = new Set<string>()

  // ⚠️ Split on `\n`, and let `trim` deal with the `\r` a CRLF file leaves behind — it is
  // whitespace, so one call covers both that and git's own rule about unescaped trailing spaces.
  // (An earlier draft carried a separate `/\r+$/` strip in front of the `trim`; it was dead, and
  // `project-gitignore.test.ts`'s CRLF case passed identically with it removed. Said here because
  // the case that guard was written for is real — a `.gitignore` is a committed, portable file, and
  // a stray `\r` inside a pattern is an ordinary character to `ruleFor` and would make every
  // imported pattern silently match nothing. It is `trim` that prevents that, not a second guard.)
  for (const raw of text.split("\n")) {
    if (add.length >= MAX_CANDIDATES) break
    const line = raw.trim()
    // Blank lines and comments are not "dropped" — they were never a pattern, and listing them as
    // problems would bury the two lines that really are.
    if (line.length === 0 || line.startsWith("#")) continue
    if (line.includes("\\")) {
      dropped.push({ source: line, reason: "escape" })
      continue
    }
    if (ProjectExclusion.ruleFor(line) === undefined) {
      dropped.push({ source: line, reason: "outside-root" })
      continue
    }
    if (have.has(line)) {
      already.push(line)
      continue
    }
    if (seen.has(line)) continue
    seen.add(line)
    add.push(line)
    if (line.startsWith("!")) reincludes.push(line)
  }
  return { add, already, dropped, reincludes }
}

/**
 * The `exclude` list a confirmed import would write: the current one, then the new patterns.
 *
 * 🔴 **Appended, never merged or sorted.** `evaluate` resolves by LAST MATCH, so the order of this
 * array is its meaning — sorting it, or interleaving the imported lines with the user's own, would
 * change which rule wins for a path that two of them match. The user's existing list keeps its
 * relative order and its precedence, and the import lands after it, which is also the only order a
 * person can reason about ("these were added at the end").
 */
export function merged(existing: readonly string[], proposal: Proposal): readonly string[] {
  return [...existing, ...proposal.add]
}
