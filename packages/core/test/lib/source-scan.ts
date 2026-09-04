import ts from "typescript"

/**
 * 🔴 **Remove comments from TypeScript source without removing anything else.**
 *
 * Nine ledgers in this directory grep source for a shape — a `git init`, a `taskkill /T`, a config
 * filename — and every one of them must strip comments first, or a comment that MENTIONS the shape
 * is counted as a live use. `log-event-ledger.ts` already learned the AST half of this lesson on
 * 2026-08-06, when a regex version counted a `cause` in a doc comment as a defect.
 *
 * ⚠️ **The other half was learned on 2026-09-04, and it fails in the opposite and worse direction.**
 * All nine had their own copy of a two-pass strip: block comments first, then line comments. A
 * slash-star inside a LINE comment or a string is then read as an opening delimiter, and everything
 * up to the next closing one is deleted — real code, silently. Measured across all 899 files of
 * `core/src`: 19 files lost code, `session.ts` lost **650 lines**. Every one of those ledgers asserts
 * an empty offender list, so a ledger that has gone blind and a tree that is clean are the same
 * observation. That is the failure this module exists to make impossible.
 *
 * It is also why this is not simply a better regex. A regex that consumes string and template
 * literals fixes the measured case and still has a hole — an unescaped slash-star inside a REGEX
 * literal — and a guard with a known hole is a guard nobody can reason about. The parser decides
 * what is a comment the same way the compiler does, so there is no residual case to argue.
 *
 * **Comments are replaced by SPACES rather than deleted**, so every byte keeps its offset and a
 * caller may report the line a match was found on. `git-spawn-single-site.test.ts` needed that; the other
 * eight are unaffected by getting it.
 */
export const stripComments = (source: string, fileName = "scan.ts"): string => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const blanked = source.split("")

  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      // Newlines survive so that line numbers and blank-line structure are preserved exactly.
      if (blanked[i] !== "\n" && blanked[i] !== "\r") blanked[i] = " "
    }
  }

  // Every comment in a file is leading trivia of some TOKEN. `getChildren` is used rather than
  // `forEachChild` because the latter skips punctuation — a comment before a closing brace is
  // leading trivia of that brace and nothing else, and would survive a `forEachChild` walk.
  const visit = (node: ts.Node) => {
    const children = node.getChildren(file)
    if (children.length === 0) {
      for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
        blank(range.pos, range.end)
      }
      return
    }
    for (const child of children) visit(child)
  }
  visit(file)

  return blanked.join("")
}
