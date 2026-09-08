import { describe, expect, test } from "bun:test"
import { ProjectExclusion } from "@novaclaw/core/project-exclusion"
import { ProjectGitignore } from "@novaclaw/core/project-gitignore"

/**
 * `` — **`.gitignore` import**, the suggestion half.
 *
 * 🔴 **The failure this file is written to catch is a proposal the matcher does not honour.** The
 * `exclude` section spent its whole first life as a promise nothing enforced; an importer that
 * offers a person a list of patterns, gets a confirmation, writes them, and then has them silently
 * discarded by `toRule` would rebuild exactly that — with a receipt on top. So almost every case
 * below asserts twice: what `propose` returns, AND what `ProjectExclusion.evaluate` then does with
 * it against real paths. The first alone would pass for a module that emitted decorative strings.
 *
 * ⚠️ **A/B, run by hand:** replace the `ProjectExclusion.ruleFor(line) === undefined` guard in
 * `project-gitignore.ts` with `false` and the `..`/`/`-only cases go red; delete the
 * `line.includes("\\")` guard and the escape cases go red; drop the `have.has(line)` check and the
 * de-duplication case goes red. Each was run.
 */

/** What the matcher DOES with a proposal — the half a string comparison cannot see. */
const verdict = (patterns: readonly string[], target: string, isDirectory = false) =>
  ProjectExclusion.evaluate(ProjectExclusion.compile(patterns), target, isDirectory)

const excluded = (patterns: readonly string[], target: string, isDirectory = false) =>
  verdict(patterns, target, isDirectory).excluded

describe("importing a .gitignore", () => {
  test("comments and blank lines are nothing at all — not patterns and not problems", () => {
    const proposal = ProjectGitignore.propose("# build output\n\n\n   \n# secrets\n", [])
    expect(proposal.add).toEqual([])
    expect(proposal.dropped).toEqual([])
    expect(proposal.already).toEqual([])
  })

  test("a bare name, an anchored path and a directory-only line all survive and MEAN what they read", () => {
    const proposal = ProjectGitignore.propose("node_modules\n/build\nlogs/\n", [])
    expect(proposal.add).toEqual(["node_modules", "/build", "logs/"])

    // A bare name matches at any depth …
    expect(excluded(proposal.add, "packages/app/node_modules/left-pad/index.js")).toBe(true)
    // … an anchored one does not.
    expect(excluded(proposal.add, "build/out.js")).toBe(true)
    expect(excluded(proposal.add, "packages/app/build/out.js")).toBe(false)
    // … and a trailing slash never matches a FILE of that name.
    expect(excluded(proposal.add, "logs", false)).toBe(false)
    expect(excluded(proposal.add, "logs", true)).toBe(true)
    expect(excluded(proposal.add, "logs/today.txt")).toBe(true)
  })

  test("🔴 a `!` re-inclusion is imported AND flagged, because appending it can undo an exclusion", () => {
    const proposal = ProjectGitignore.propose("*.env\n!.env.example\n", [])
    expect(proposal.add).toEqual(["*.env", "!.env.example"])
    expect(proposal.reincludes).toEqual(["!.env.example"])
    expect(excluded(proposal.add, "config/.env")).toBe(true)
    expect(excluded(proposal.add, ".env.example")).toBe(false)

    // The hazard, stated as a test rather than as a comment: the import lands after the user's own
    // list, and last match wins — so this line really does re-open a path they had shut.
    const merged = ProjectGitignore.merged([".env.example"], proposal)
    expect(excluded([".env.example"], ".env.example")).toBe(true)
    expect(excluded(merged, ".env.example")).toBe(false)
  })

  test("🔴 an escaped trailing space is DROPPED, never reinterpreted as a directory", () => {
    // `foo\ ` in a .gitignore is the file `foo `. Fed to the matcher it would become `foo/` — the
    // DIRECTORY `foo`, which is a different and probably important thing to stop reading.
    const proposal = ProjectGitignore.propose("foo\\ \n", [])
    expect(proposal.add).toEqual([])
    expect(proposal.dropped).toEqual([{ source: "foo\\", reason: "escape" }])
    // The reading we refused to apply, pinned so the refusal cannot be "tidied" later.
    expect(excluded(["foo\\ "], "foo", true)).toBe(true)
  })

  test("an escaped `#` (a file literally named `#notes`) is dropped for the same reason", () => {
    const proposal = ProjectGitignore.propose("\\#notes\n", [])
    expect(proposal.add).toEqual([])
    expect(proposal.dropped.map((item) => item.reason)).toEqual(["escape"])
  })

  test("unescaped trailing whitespace is stripped, matching git — the pattern still bites", () => {
    const proposal = ProjectGitignore.propose("secrets/   \n", [])
    expect(proposal.add).toEqual(["secrets/"])
    expect(excluded(proposal.add, "secrets/id_rsa")).toBe(true)
  })

  test("CRLF line endings do not smuggle a `\\r` into every pattern", () => {
    const proposal = ProjectGitignore.propose("dist\r\n*.log\r\n", [])
    expect(proposal.add).toEqual(["dist", "*.log"])
    expect(excluded(proposal.add, "dist/app.js")).toBe(true)
    expect(excluded(proposal.add, "server.log")).toBe(true)
  })

  test("a line that climbs out of the project is reported, not silently missing", () => {
    const proposal = ProjectGitignore.propose("../elsewhere\n/\n.\nkeep-me\n", [])
    expect(proposal.add).toEqual(["keep-me"])
    expect(proposal.dropped).toEqual([
      { source: "../elsewhere", reason: "outside-root" },
      { source: "/", reason: "outside-root" },
      { source: ".", reason: "outside-root" },
    ])
    // The tie that makes this test worth having: the reason those three are dropped is that the
    // matcher itself refuses them, not that this module has an opinion about them.
    for (const line of ["../elsewhere", "/", "."]) expect(ProjectExclusion.ruleFor(line)).toBeUndefined()
  })

  test("patterns already in the project's exclude list are reported as already there, not re-added", () => {
    const proposal = ProjectGitignore.propose("node_modules\n.env\n", ["node_modules"])
    expect(proposal.add).toEqual([".env"])
    expect(proposal.already).toEqual(["node_modules"])
    expect(ProjectGitignore.merged(["node_modules"], proposal)).toEqual(["node_modules", ".env"])
  })

  test("a line repeated inside the .gitignore is added once", () => {
    const proposal = ProjectGitignore.propose("*.log\nbuild\n*.log\n", [])
    expect(proposal.add).toEqual(["*.log", "build"])
  })

  test("a real-world .gitignore imports as a list that behaves the way it reads", () => {
    // Lifted from the shapes a normal Node/Python repo carries.
    const gitignore = [
      "# Logs",
      "logs",
      "*.log",
      "npm-debug.log*",
      "",
      "# Dependency directories",
      "node_modules/",
      "jspm_packages/",
      "",
      "# Build output",
      "/dist",
      "/build",
      "**/__pycache__/",
      "",
      "# Env",
      ".env",
      ".env.*",
      "!.env.example",
      "",
      "# Editors",
      ".idea/",
      ".vscode/*",
      "!.vscode/settings.json",
    ].join("\n")

    const proposal = ProjectGitignore.propose(gitignore, [])
    expect(proposal.dropped).toEqual([])
    expect(proposal.reincludes).toEqual(["!.env.example", "!.vscode/settings.json"])
    expect(proposal.add).toEqual([
      "logs",
      "*.log",
      "npm-debug.log*",
      "node_modules/",
      "jspm_packages/",
      "/dist",
      "/build",
      "**/__pycache__/",
      ".env",
      ".env.*",
      "!.env.example",
      ".idea/",
      ".vscode/*",
      "!.vscode/settings.json",
    ])

    const patterns = proposal.add
    expect(excluded(patterns, "npm-debug.log.1")).toBe(true)
    expect(excluded(patterns, "packages/core/node_modules", true)).toBe(true)
    expect(excluded(patterns, "dist/index.js")).toBe(true)
    // Anchored, so a nested `dist` is NOT covered — the same reading git gives it.
    expect(excluded(patterns, "packages/app/dist/index.js")).toBe(false)
    expect(excluded(patterns, "src/pkg/__pycache__/mod.pyc")).toBe(true)
    expect(excluded(patterns, ".env")).toBe(true)
    expect(excluded(patterns, ".env.local")).toBe(true)
    expect(excluded(patterns, ".env.example")).toBe(false)
    expect(excluded(patterns, ".vscode/launch.json")).toBe(true)
    expect(excluded(patterns, ".vscode/settings.json")).toBe(false)
    // The refusal has to be able to NAME the line that produced it.
    expect(verdict(patterns, "dist/index.js").pattern).toBe("/dist")
  })

  test("a very long .gitignore is truncated at a listable size rather than proposed whole", () => {
    const text = Array.from({ length: ProjectGitignore.MAX_CANDIDATES + 50 }, (_, i) => `pattern-${i}`).join("\n")
    const proposal = ProjectGitignore.propose(text, [])
    expect(proposal.add.length).toBe(ProjectGitignore.MAX_CANDIDATES)
    expect(proposal.add[0]).toBe("pattern-0")
  })
})
