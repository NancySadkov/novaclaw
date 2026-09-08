import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * 🔴 **ONE git spawn in `packages/novaclaw/src`, and this is what makes that true rather than
 * remembered.**
 *
 * `Git.CONFIG_ARGS` carries `--no-optional-locks` (the flag that stops `status`/`diff`/`ls-files`
 * taking `index.lock`) and `core.longpaths=true` (without which `worktree add` / `reset --hard` /
 * `clean -ffdx` fail on Windows deep trees with git's "Filename too long"). Both costs were observed,
 * not imagined, and both came from a second module opening its own `git` process with a shorter list.
 *
 * ⚠️ **Exporting the list did not close it, and that is the lesson this file exists to pin.** The
 * 2026-09-01 pass aliased `snapshot/`'s three local arrays to `Git.CONFIG_ARGS` and left the SPREAD
 * at each call site. Thirteen of `snapshot/`'s invocations spread nothing — `init`, its eight
 * `config` writes, both `rev-parse`s, `gc`, `write-tree` — so a third of the module still ran bare
 * while the ledger recorded the divergence as closed. A shared constant plus a per-call-site
 * discipline is not one invocation prefix; a shared spawn is.
 *
 * So the invariant is structural: exactly one place in `packages/novaclaw/src` may hand a git
 * executable to `ChildProcess.make`, and it is `Git.spawn`, which applies the list unconditionally.
 * That one place now passes `gitBinary()` — core's `binary()`, which prefers a system git and falls
 * back to the provisioned PortableGit, so the revert substrate works on a machine with no git. The
 * bare `"git"` literal is still matched here, so a regression back to it is a SECOND site rather
 * than an invisible one.
 *
 * ⚠️ Scoped to `packages/novaclaw/src` on purpose. `packages/core/src/git.ts` is a different service
 * with its own executable resolution (`binary()` → system git, else the bundled PortableGit) and its
 * own per-repository `core.longpaths` config write; it is not a fourth copy of this prefix and must
 * not be dragged in by a wider glob.
 */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SCOPE = path.join(ROOT, "packages", "novaclaw", "src")

/**
 * Source with comments removed, then matched. ⚠️ The regex-over-raw-source version of this counts
 * PROSE: `worktree/index.ts` carries the line *"`Git.spawn`, not a local `ChildProcess.make`"*, and
 * a scanner that reads comments would report the very file the rule fixed as a violation.
 *
 * 🔴 It had its OWN stripper until 2026-09-04, and so did eight other ledgers. All nine ran
 * block comments before line comments, so a slash-star inside a line comment or a string opened a
 * comment that ran to the next closing delimiter and deleted real code in between. This one’s
 * variant blanked comments with SPACES to keep offsets, which `gitSpawnLines` below depends on —
 * the shared implementation keeps that property, which is why it could replace this one.
 */
const SPAWN = /ChildProcess\.make\(\s*(?:"git"|gitBinary\(\))/g

/** Every line in `source` that hands the literal `"git"` to `ChildProcess.make`, comments excluded. */
export const gitSpawnLines = (source: string): number[] => {
  const clean = stripComments(source)
  const lines: number[] = []
  for (const hit of clean.matchAll(SPAWN)) {
    lines.push(clean.slice(0, hit.index).split("\n").length)
  }
  return lines
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full)
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
  })

/**
 * One entry per spawn, named by FILE and not by `file:line` — a line pin churns on every edit above
 * it and would train the next author to re-pin rather than read. Two spawns in one file still show
 * as two entries.
 */
const SITES = walk(SCOPE).flatMap((file) =>
  gitSpawnLines(fs.readFileSync(file, "utf8")).map(() => path.relative(ROOT, file).replaceAll("\\", "/")),
)

describe("one git spawn", () => {
  test("the walk reached the real tree, not an empty set", () => {
    // Without this every assertion below is a filter over nothing and passes forever — the
    // guard-shaped no-op. Measured 2026-09-01: 256 `.ts` files under `packages/novaclaw/src`.
    expect(walk(SCOPE).length).toBeGreaterThan(200)
    expect(SITES.length).toBeGreaterThan(0)
  })

  test("🔴 `packages/novaclaw/src` opens a git process in exactly ONE place", () => {
    // A second entry means a module grew its own spawn again, and it is running without
    // `--no-optional-locks` and `core.longpaths=true` unless it copied them too. The fix is to call
    // `Git.spawn`, never to add a path here.
    expect(SITES).toEqual(["packages/novaclaw/src/git/index.ts"])
  })

  test("and that one place is inside `Git.spawn`, applying CONFIG_ARGS", () => {
    // Non-vacuity for the check above: it would also pass on a tree whose single spawn had quietly
    // stopped prefixing the list.
    const source = fs.readFileSync(path.join(SCOPE, "git", "index.ts"), "utf8")
    // The LINE, not the whole file: a `toContain` over 380 lines prints all of them on failure and
    // buries the one word that changed.
    const line = stripComments(source)
      .split("\n")
      .find((item) => item.includes("ChildProcess.make(gitBinary()"))
    expect(line?.trim()).toBe("ChildProcess.make(gitBinary(), [...CONFIG_ARGS, ...args], {")
  })

  test("the scan bites on a fresh spawn, and not on one described in a comment (negative control)", () => {
    expect(gitSpawnLines('const r = appProcess.run(ChildProcess.make("git", args, {}))')).toEqual([1])
    // …and on the resolved form too, so the guard cannot be evaded by taking the correct call twice.
    expect(gitSpawnLines("const r = appProcess.run(ChildProcess.make(gitBinary(), args, {}))")).toEqual([1])
    // Multi-line call — the shape a `\n` after the paren would hide from a naive pattern.
    expect(gitSpawnLines('appProcess.run(\n  ChildProcess.make(\n    "git",\n    args,\n  ),\n)')).toEqual([2])
    // …and the two comment forms that a regex over raw source counts as violations.
    expect(gitSpawnLines('// use Git.spawn, not ChildProcess.make("git", args)')).toEqual([])
    expect(gitSpawnLines('/**\n * Never ChildProcess.make("git", args) here.\n */')).toEqual([])
    // A URL is not a line comment — proof the stripper does not eat code around `//`.
    expect(gitSpawnLines('const u = "https://x/y"\nChildProcess.make("git", a, {})')).toEqual([2])
  })
})
