import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **A fixture git repository is built ONCE per process and copied**, and this is the check that
 * makes that sentence true rather than aspirational.
 *
 * ⚠️ Why a guard and not a review. "Nobody hand-rolls `git init` in a test" is a claim about code in
 * files other than the one it is written in — the defect class that compiles green, so a review is
 * the wrong instrument (todo.md ruling 1: an invariant without a mechanical check does not exist).
 * By 2026-07-28 there were **six** independent copies of the same `git init` + identity-config
 * ritual under `packages/core/test/`, and the four in the git-backed suites cost real wall clock:
 * the ritual is eight git processes at ~100 ms each (measured: 820 ms via `execFile`, 1177 ms via
 * `bun $`) against **19–36 ms** for an `fs.cp` of the finished repository. Fourteen rebuilds across
 * five suites is the difference between a gate that fits the owner's 5-minute budget and one that
 * does not (todo/test-speed.md).
 *
 * So: any file under `packages/core/test/` that runs `git init` itself, or writes the
 * `user.email` / `user.name` fixture identity, must be **in the ledger below, with a reason**. The
 * ledger is a RATCHET — it fails in both directions. A new site fails outright; a listed site that
 * no longer has one fails with "drop the ledger entry", so a fix forces the entry out and the list
 * can only shrink.
 *
 * The one thing this test cannot see is whether the shared fixture is actually FAST. That is the
 * `repo()` / `gitRemote()` implementation in `test/fixture/git.ts`, whose memo + copy shape is
 * pinned below so a regression to per-call rebuilding cannot pass while still satisfying the sweep.
 */

/** The app repo root: `packages/core/test` → `packages/core` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

/** Only the `core` test tree. The other packages' suites are a separate problem with separate owners. */
const SCAN_ROOT = "packages/core/test"

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", ".git", ".turbo"])

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

/**
 * This file itself. It quotes every shape it hunts for, so without this it would be its own first
 * offender. Excluded by name rather than by a magic marker comment, because a marker in a source
 * file would be an opt-out anyone could paste.
 */
const SELF = "packages/core/test/git-fixture-ledger.test.ts"

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so this answers "does this file DO it", never "does it
   *  mention it" — the collapsed sites all explain in prose what they used to hand-roll. */
  readonly text: string
}

/** The comment stripper `src/jh/imports.test.ts` uses — `//` must not eat the `//` in a URL. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string, out: Source[]): Source[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".d.ts")) continue
    if (!EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
    const name = path.relative(ROOT, full).replaceAll("\\", "/")
    if (name === SELF) continue
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

const sources = collect(path.join(ROOT, SCAN_ROOT), [])

/**
 * The shapes a hand-rolled fixture repository takes. Each is the *mechanism*, not a name a refactor
 * could rename away — and each is deliberately narrow enough that a SCENARIO git call (a
 * `git worktree add` the test is about, a `git add` whose staging it then asserts on) does not trip
 * it. Only repository CREATION is the pattern being collapsed.
 *
 * ⚠️ **Known blind spot, measured 2026-07-31: the sweep strips COMMENTS but not string literals, so a
 * test TITLE reading "…`git init` must be seen immediately" trips it.** That happened once
 * (`project-resolve-cache.test.ts`, a file that spawns no git at all — every repository in it is a
 * stub), and the fix was to rename the title, NOT to add a ledger entry: ledgering a file that does
 * not build a repository would have made this ledger's own claim false while looking like diligence.
 * Stripping literals too was considered and declined — a title is the only literal that plausibly
 * carries the phrase, and a stripper that ate strings would also eat the argv forms above, which are
 * literals by construction. If this false-positives a second time, that trade is worth re-opening.
 */
const SHAPES: ReadonlyArray<{ readonly what: string; readonly re: RegExp }> = [
  // `git init` in every spelling this tree has used: a bun `$` template string, and the argv forms
  // for `execFile`/a `git(cwd, ...args)` helper. `"initial"` must NOT match, hence the closing quote.
  {
    what: "a hand-rolled `git init`",
    re: /\bgit\s+init\b|\bgit\(\s*[^)]*?["']init["']|["']git["']\s*,\s*\[\s*["']init["']/,
  },
  // The fixture identity. A repository that needs `user.email`/`user.name` written into it is a
  // repository being built from scratch — there is nothing else in this tree that writes them.
  { what: "the `user.email` / `user.name` fixture identity ritual", re: /\buser\.(?:email|name)\b/ },
]

const shapesIn = (text: string): string[] => SHAPES.filter((shape) => shape.re.test(text)).map((shape) => shape.what)

/**
 * The mechanism that makes the fixture cheap: a memo keyed on the recipe, and a directory copy. A
 * `repo()` rewritten to rebuild per call would still export the right names, so the names alone are
 * not the pin — these are.
 */
const REUSE_MARKERS = ["templates.get(", "templates.set(", "fs.cp("] as const

const missingReuseMarkers = (text: string): string[] => REUSE_MARKERS.filter((marker) => !text.includes(marker))

/**
 * ─── the ledger ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every file allowed to build a git repository by hand, and WHY. The canonical fixture first, then
 * the outstanding ones.
 *
 * ⚠️ Adding an entry here is a decision with a cost — it is eight more git processes per test, on a
 * gate the owner has capped at 5 minutes. Take `repo()` / `gitRemote()` / `withRemote()` from
 * `test/fixture/git.ts` unless the setup is genuinely unlike theirs, and say so in the reason.
 *
 * The ratchet has shrunk once already: `project.test.ts` and `filesystem/watcher.test.ts` were FILED
 * here on 2026-07-28 and collapsed on 2026-07-29. Measured over those two files together, on a box
 * running three other agents: **90 → 20 git processes, 12.41 s → 8.39 s**, with the test totals
 * unchanged (16 tests, 15 pass / 1 skip, 29 `expect()` calls before and after).
 */
const LEDGER = new Map<string, string>([
  [
    "packages/core/test/fixture/git.ts",
    "THE fixture. Builds each distinct repository shape ONCE per process (memoized on a digest of " +
      "its recipe, so two callers cannot silently share one repo) and hands out `fs.cp` copies. " +
      "`repo()` covers the plain-checkout shape, `gitRemote()`/`withRemote()` the bare-origin + " +
      "pushed-source shape.",
  ],
  [
    "packages/core/test/ripgrep.test.ts",
    "One `Bun.$\\`git init -q\\`` with no commit and no identity — it only needs a `.git` dir so " +
      "ripgrep honours `.gitignore`. ONE bare init in the whole file, and it is the cheapest form " +
      "of it (no identity config, no commit), so collapsing it would trade a single git process for " +
      "a template copy and buy nothing measurable. Deliberate keep, not a backlog item.",
  ],
])

/**
 * The suites this unit collapsed. Each must still take its repository FROM the fixture, or the
 * collapse regressed: deleting the call rather than replacing it would pass the offender sweep above
 * while silently restoring the per-test rebuild.
 */
const COLLAPSED: ReadonlyArray<readonly [string, RegExp]> = [
  ["packages/core/test/snapshot.test.ts", /\brepo\(/],
  ["packages/core/test/git.test.ts", /\brepo\(/],
  ["packages/core/test/git.test.ts", /\bwithRemote\(/],
  ["packages/core/test/repository-cache.test.ts", /\bwithRemote\(/],
  ["packages/core/test/move-session.test.ts", /\brepo\(/],
  // 2026-07-29 — the two suites the ledger had FILED. `project.test.ts` needed two additive
  // `repo()` options (`commit: false` for the no-commits case, and `origin` applied per COPY so its
  // four remote URLs — one of them a per-call `file://<tmpdir>` — still share one template);
  // `watcher.test.ts` needed nothing but the call.
  ["packages/core/test/project.test.ts", /\brepo\(/],
  ["packages/core/test/filesystem/watcher.test.ts", /\brepo\(/],
]

describe("the sweep", () => {
  test("actually has the test tree to look at", () => {
    // A mistyped root, a moved test file or a bad SKIP_DIRS entry would silently empty the sweep and
    // turn every assertion below into a tautology.
    expect(sources.length).toBeGreaterThan(50)
  })

  test("reaches every file that has ever hand-rolled a fixture repository", () => {
    const names = new Set(sources.map((file) => file.name))
    for (const name of [
      "packages/core/test/fixture/git.ts",
      "packages/core/test/snapshot.test.ts",
      "packages/core/test/git.test.ts",
      "packages/core/test/move-session.test.ts",
      "packages/core/test/repository-cache.test.ts",
      "packages/core/test/project.test.ts",
      "packages/core/test/filesystem/watcher.test.ts",
      "packages/core/test/ripgrep.test.ts",
    ])
      expect(names, `${name} is not in the sweep`).toContain(name)
  })
})

describe("a fixture git repository is built once and copied", () => {
  test("no unledgered test builds one by hand", () => {
    const offenders = sources
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
      .sort()
    // Take `repo(destination, files)` / `withRemote(body)` from `test/fixture/git.ts`. If your setup
    // genuinely is not one of those shapes, extend the fixture — and only if you cannot, add an entry
    // to LEDGER above WITH ITS REASON, and expect that reason to be read.
    expect(offenders).toEqual([])
  })

  test("the ledger can only SHRINK — a fixed or vanished entry must be deleted from it", () => {
    const stale: string[] = []
    for (const name of LEDGER.keys()) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        stale.push(`${name} (no longer exists — drop the ledger entry)`)
        continue
      }
      if (shapesIn(file.text).length === 0)
        stale.push(`${name} (no longer builds a repository by hand — drop the ledger entry)`)
    }
    expect(stale).toEqual([])
  })

  test("the fixture the ledger points at still MEMOIZES and COPIES", () => {
    const fixture = sources.find((file) => file.name === "packages/core/test/fixture/git.ts")
    expect(fixture, "packages/core/test/fixture/git.ts vanished from the sweep").toBeDefined()
    // A `repo()` that re-ran `git init` per call would satisfy every assertion above while giving
    // back all 14 rebuilds — "reads as a shared fixture while being none".
    expect(missingReuseMarkers(fixture!.text), "fixture/git.ts no longer memoizes + copies").toEqual([])
    for (const marker of [
      "export async function repo",
      "export async function gitRemote",
      "export function withRemote",
    ])
      expect(fixture!.text, `fixture/git.ts no longer exports ${marker}`).toContain(marker)
  })

  test("every suite this unit collapsed still takes its repository from the fixture", () => {
    const regressed: string[] = []
    for (const [name, expected] of COLLAPSED) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        regressed.push(`${name} (missing from the sweep)`)
        continue
      }
      if (!expected.test(file.text)) regressed.push(`${name} (no longer calls ${String(expected)})`)
      if (!/from "\.{1,2}\/fixture\/git"/.test(file.text)) regressed.push(`${name} (no longer imports ./fixture/git)`)
    }
    expect(regressed).toEqual([])
  })
})

describe("the guard actually bites (negative control)", () => {
  test("each shape matches the copy it was written for", () => {
    // The four spellings that were live in this tree on 2026-07-28.
    expect(shapesIn("await $`git init`.cwd(project).quiet()")).toContain("a hand-rolled `git init`")
    expect(shapesIn("yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)")).toContain(
      "a hand-rolled `git init`",
    )
    expect(shapesIn(`await git(root, "init", "--bare", origin)`)).toContain("a hand-rolled `git init`")
    expect(shapesIn(`await exec("git", ["init"], { cwd })`)).toContain("a hand-rolled `git init`")
    expect(shapesIn("await $`git config user.email test@novaclaw.test`.cwd(dir).quiet()")).toContain(
      "the `user.email` / `user.name` fixture identity ritual",
    )
    expect(shapesIn(`await git(directory, "config", "user.name", "Test")`)).toContain(
      "the `user.email` / `user.name` fixture identity ritual",
    )
  })

  test("it does NOT fire on the collapsed form, on scenario git, or on prose about it", () => {
    // The collapsed shape must be silent, or every fixed suite would land straight back in the ledger.
    expect(shapesIn(`await repo(project, { "tracked.txt": "one\\n" })`)).toEqual([])
    expect(shapesIn(`withRemote((fixture) => Effect.gen(function* () {}))`)).toEqual([])
    // Scenario git — the calls that ARE the subject — must stay invisible to this guard.
    expect(shapesIn(`await git(project, "worktree", "add", "--detach", linked, "HEAD")`)).toEqual([])
    expect(shapesIn(`await git(source, "add", "packages/staged.txt")`)).toEqual([])
    expect(shapesIn(`await gitText(source, "status", "--porcelain")`)).toEqual([])
    // `"initial"` starts with `init` and is the commit message half this tree uses.
    expect(shapesIn(`await git(source, "commit", "-m", "initial")`)).toEqual([])
    // A digit-suffixed identifier must not read as the identity ritual.
    expect(shapesIn(`const user = { name: "Test" }`)).toEqual([])
    // …and a file that only TALKS about the old ritual is code-clean, because comments are stripped.
    expect(shapesIn(stripComments("// this used to run git init and git config user.email\nconst x = 1"))).toEqual([])
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The offender predicate itself, exercised on a synthetic file: the real sweep asserts an EMPTY
    // list, which alone cannot show that a non-empty one is reachable.
    const synthetic: Source = {
      name: "packages/core/test/rogue.test.ts",
      text: "await $`git init`.cwd(dir).quiet()\nawait $`git config user.email test@novaclaw.test`.cwd(dir).quiet()",
    }
    const offenders = [synthetic]
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
    expect(offenders).toEqual([
      "packages/core/test/rogue.test.ts → a hand-rolled `git init`, the `user.email` / `user.name` fixture identity ritual",
    ])
  })

  test("a fixture that stopped memoizing is what the reuse pin reports", () => {
    // The other direction, exercised on a synthetic fixture: the real test asserts an EMPTY list of
    // missing markers, which alone cannot show that a non-empty one is reachable. This body exports
    // exactly the right names and rebuilds on every call — the regression the pin exists to catch.
    const regressed = `export async function repo(destination: string) {
      await git(destination, "init")
      return destination
    }`
    expect(missingReuseMarkers(regressed)).toEqual(["templates.get(", "templates.set(", "fs.cp("])
    // …and the real fixture is the control in the other direction.
    const fixture = sources.find((file) => file.name === "packages/core/test/fixture/git.ts")
    expect(missingReuseMarkers(fixture!.text)).toEqual([])
  })
})
