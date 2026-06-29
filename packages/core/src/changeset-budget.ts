export * as ChangesetBudget from "./changeset-budget"

// 1G harness-robustness: bound the cost of diffing a huge change set. `git.tree.diff`
// spawns ~3 git subprocesses per file and buffers every patch in memory, so a
// thousands-file or multi-MB change set hangs the instance and can OOM the renderer.
// We cap how many file patches are actually computed — by file count AND cumulative
// patch bytes. Files beyond the budget are still listed, with the patch omitted, so
// nothing silently vanishes. The file-NAME list (which `revert` relies on) is never
// capped here — only the expensive per-file diffs are.
//
// Pure and dependency-light so the budget logic is unit-testable without a repo.

export const MAX_DIFF_FILES = 300
export const MAX_DIFF_BYTES = 4 * 1024 * 1024

export interface Limits {
  readonly maxFiles?: number
  readonly maxBytes?: number
}

export interface Spent {
  readonly files: number
  readonly bytes: number
}

// True while there is room to compute another real per-file diff.
export function withinBudget(spent: Spent, limits: Limits = {}): boolean {
  return spent.files < (limits.maxFiles ?? MAX_DIFF_FILES) && spent.bytes < (limits.maxBytes ?? MAX_DIFF_BYTES)
}

// Which budget was hit first, so the omission message can say why.
export function exceededBy(spent: Spent, limits: Limits = {}): "count" | "bytes" {
  return spent.files >= (limits.maxFiles ?? MAX_DIFF_FILES) ? "count" : "bytes"
}

export function omittedPatch(reason: "count" | "bytes", limits: Limits = {}): string {
  if (reason === "count")
    return `(diff omitted — change set exceeds the ${limits.maxFiles ?? MAX_DIFF_FILES}-file display budget)`
  return `(diff omitted — change set exceeds the ${Math.round((limits.maxBytes ?? MAX_DIFF_BYTES) / 1024 / 1024)} MB diff budget)`
}

// One-line summary for a partially-diffed change set, or undefined when all diffed.
export function summary(total: number, computed: number, bytes: number): string | undefined {
  if (computed >= total) return undefined
  return (
    `${total} files changed; computed diffs for the first ${computed} (~${Math.round(bytes / 1024)} KB). ` +
    `${total - computed} more are listed with their diff omitted (change set too large).`
  )
}
