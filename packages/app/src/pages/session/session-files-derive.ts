import type { SessionChangeDiff, VcsFileDiff } from "@novaclaw/sdk/v2"

/** The shape the panel's `renderDiff` narrows to, so `file` is present and `status` is readable. */
export type RenderedDiff = (SessionChangeDiff & { file: string }) | VcsFileDiff

export type DiffKind = "add" | "del" | "mix"

export const diffPaths = (diffs: readonly RenderedDiff[]): string[] =>
  diffs.map((diff) => diff.file).filter((file): file is string => !!file)

/**
 * 🔴 **A CHANGED FILE AND THE FOLDER HOLDING IT ARE REGISTERED SEPARATELY, AND DROPPING EITHER
 * ONE SILENTLY MISCOLOURS THE TREE.**
 *
 * This was not a hypothetical. The first version of the port into the context inspector coloured
 * directories only, because the loop that walks `parts.slice(0, -1)` is the part you notice while
 * you are looking at the tree. The result reads as a theming bug and is not one: the changed file
 * itself carries no letter, so the one row the user is looking for is the one row that looks
 * untouched.
 *
 * Separated from the component so it can be tested as the pure function it is. Inline, this was
 * only ever checkable by reading the old source, which is exactly how the first version shipped
 * wrong.
 */
/**
 * 🔴 **A STRING ESCAPE CARRIED THROUGH A PORT, STOPPING MEANING WHAT IT MEANT.**
 *
 * The pill this replaces normalized with `replaceAll("\\\\", "/")` — a TWO-backslash string, which
 * looks like an escaped backslash but is not one. Measured: it leaves `src\pages\a.tsx` entirely
 * unchanged, so a Windows-shaped path was never normalized at all. The consequence is not cosmetic.
 * The path splits on `/` into a single part, the `slice(0, -1)` directory walk registers nothing,
 * and the key that does get stored is the backslashed path — which the tree, keyed on forward
 * slashes, never matches. A backslashed path therefore got no colour AND no row.
 *
 * The class is "an escape that survives a move between a regex and a string literal without anyone
 * re-reading what it means", which is why the sibling sweep is the test below rather than a grep:
 * the grep for the two-backslash literal finds exactly this one site.
 */
export const diffKinds = (diffs: readonly RenderedDiff[]): Map<string, DiffKind> => {
  const merge = (a: DiffKind | undefined, b: DiffKind) => {
    if (!a) return b
    if (a === b) return a
    return "mix" as const
  }
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "")

  const out = new Map<string, DiffKind>()
  for (const diff of diffs) {
    if (!diff.file) continue
    const file = normalize(diff.file)
    const kind: DiffKind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

    // The file itself, then every directory above it.
    out.set(file, kind)
    const parts = file.split("/")
    for (const [index] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, index + 1).join("/")
      if (!dir) continue
      out.set(dir, merge(out.get(dir), kind))
    }
  }
  return out
}
