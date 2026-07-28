import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **A fixture git repository is built ONCE per process and copied**, and this is the check that
 * makes that sentence true rather than aspirational for `packages/novaclaw/test/`.
 *
 * The companion to `packages/core/test/git-fixture-ledger.test.ts`, whose own scan root carries the
 * note *"The other packages' suites are a separate problem with separate owners."* This file is that
 * owner. It is deliberately NOT a shared module: a scanner parameterised over two roots would have
 * to reconcile two different fixtures with two different ledgers, and the failure messages are the
 * product here.
 *
 * ⚠️ Why a guard and not a review. "Nobody hand-rolls `git init` in a test" is a claim about code in
 * files other than the one it is written in — the defect class that compiles green, so a review is
 * the wrong instrument (todo.md ruling 1). Measured with `GIT_TRACE` on 2026-07-28 over
 * `httpapi-workspace` + `httpapi-workspace-routing` + `httpapi-instance-context`: 23 `git: true`
 * call sites cost **184 git processes**, 10.4 s of setup plus 1.7 s of teardown inside a 38.2 s
 * run. `packages/novaclaw/test/` holds **199** `git: true` sites in all, 75 of them under
 * `test/server/` alone, so the per-site cost is the gate's cost (todo/test-speed.md, owner cap: 5
 * minutes).
 *
 * ⚠️ **This file lives under `test/fixture/` on purpose.** That is one of
 * `PROMOTED_NOVACLAW_SUBDIRS` in `script/test.ts`, i.e. a run unit in the DEFAULT tier. At the test
 * tree's root it would have been `--full`-only, and a ratchet nobody runs is not a ratchet.
 */

/** The app repo root: `packages/novaclaw/test/fixture` → `test` → `novaclaw` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")

/** Only the `novaclaw` test tree. `packages/core/test` has its own ledger and its own fixture. */
const SCAN_ROOT = "packages/novaclaw/test"

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".git",
  ".turbo",
  "fixtures",
  "snapshots",
])

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

/**
 * This file itself. It quotes every shape it hunts for, so without this it would be its own first
 * offender. Excluded by name rather than by a magic marker comment, because a marker in a source
 * file would be an opt-out anyone could paste.
 */
const SELF = "packages/novaclaw/test/fixture/git-fixture-ledger.test.ts"

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so this answers "does this file DO it", never "does it
   *  mention it" — the fixture explains in prose what it used to hand-roll. */
  readonly text: string
}

/** The comment stripper `core/src/jh/imports.test.ts` uses — `//` must not eat the `//` in a URL. */
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
 * could rename away — and each is deliberately narrow enough that a SCENARIO git call (the
 * `git worktree add` a worktree test is about, the `git checkout -b` whose branch it then asserts
 * on) does not trip it. Only repository CREATION is the pattern being collapsed.
 */
const SHAPES: ReadonlyArray<{ readonly what: string; readonly re: RegExp }> = [
  // `git init` in every spelling this tree has used: a bun `$` template string, and the argv forms
  // for `execFile`/a `git(cwd, ...args)` helper. `git config init.defaultBranch` must NOT match,
  // hence the required word boundary immediately after `init`.
  {
    what: "a hand-rolled `git init`",
    re: /\bgit\s+init(?![.\w])|\bgit\(\s*[^)]*?["']init["']|["']git["']\s*,\s*\[\s*["']init["']|gitExec\([^)]*?["']init["']/,
  },
  // The fixture identity. A repository that needs `user.email`/`user.name` written into it is a
  // repository being built from scratch — there is nothing else in this tree that writes them.
  { what: "the `user.email` / `user.name` fixture identity ritual", re: /\buser\.(?:email|name)\b/ },
]

const shapesIn = (text: string): string[] => SHAPES.filter((shape) => shape.re.test(text)).map((shape) => shape.what)

/**
 * ─── the ledger ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every file allowed to build a git repository by hand, and WHY.
 *
 * ⚠️ Adding an entry here is a decision with a cost — six more git processes per test on a gate the
 * owner has capped at 5 minutes. Take `tmpdir({ git: true })` / `tmpdirScoped({ git: true })` from
 * `test/fixture/fixture.ts` unless the setup is genuinely unlike theirs, and say so in the reason.
 */
const LEDGER = new Map<string, string>([
  [
    "packages/novaclaw/test/fixture/fixture.ts",
    "THE fixture. Runs `git init` + the identity config ONCE per process into a PID-named template " +
      "under os.tmpdir(), and hands out `fs.cp` copies. Both `tmpdir()` and `tmpdirScoped()` go " +
      "through the single `provisionGit()`, pinned below.",
  ],
  [
    "packages/novaclaw/test/fixture/fixture.test.ts",
    "READS `git config user.email` back out of a provisioned directory to prove the copy carries " +
      "the identity. It asserts the ritual; it does not perform one. The shape cannot tell a read " +
      "from a write, and narrowing it to try would weaken the sweep everywhere else.",
  ],
])

/**
 * The property that makes the fixture cheap AND the property that makes it safe. A `provisionGit`
 * rewritten to run the ritual per call would still export every right name, so the names alone are
 * not the pin — these are.
 *
 * `gitTemplate ??=` is the per-process memo; `fs.cp(` is the copy; `preserveTimestamps` keeps the
 * copy's `.git/index` valid instead of leaving the whole worktree stat-dirty.
 */
const REUSE_MARKERS = ["gitTemplate ??=", "fs.cp(", "preserveTimestamps: true"] as const

const missingReuseMarkers = (text: string): string[] => REUSE_MARKERS.filter((marker) => !text.includes(marker))

/**
 * The two entry points, sliced out of the fixture by their own declarations.
 *
 * ⚠️ This is the check that replaces the comment that used to sit above `tmpdirScoped`: *"Make sure
 * these stay in sync"*. Two hand-written copies of one ritual kept honest by a request to a future
 * reader is ruling 1's defect class by definition. Both bodies must reach `provisionGit`.
 */
const bodyOf = (text: string, start: RegExp, end: RegExp): string | undefined => {
  const from = text.search(start)
  if (from === -1) return undefined
  const rest = text.slice(from + 1)
  const to = rest.search(end)
  return to === -1 ? undefined : rest.slice(0, to)
}

const ENTRY_POINTS: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
  ["tmpdir", /export async function tmpdir</, /export function tmpdirScoped</],
  ["tmpdirScoped", /export function tmpdirScoped</, /export const provideInstance\b/],
]

const entryPointsMissingProvision = (text: string): string[] =>
  ENTRY_POINTS.flatMap(([name, start, end]) => {
    const body = bodyOf(text, start, end)
    if (body === undefined) return [`${name} (could not be located in fixture.ts — update this guard)`]
    return body.includes("provisionGit(") ? [] : [`${name} (no longer calls provisionGit)`]
  })

describe("the sweep", () => {
  test("actually has the test tree to look at", () => {
    // A mistyped root, a moved test file or a bad SKIP_DIRS entry would silently empty the sweep and
    // turn every assertion below into a tautology.
    expect(sources.length).toBeGreaterThan(100)
  })

  test("reaches the files that do, or nearly do, build a fixture repository by hand", () => {
    const names = new Set(sources.map((file) => file.name))
    for (const name of [
      "packages/novaclaw/test/fixture/fixture.ts",
      "packages/novaclaw/test/fixture/fixture.test.ts",
      // Scenario git that must stay INVISIBLE to the shapes — if one of these ever trips, the
      // regexes widened and the sweep started reporting the thing under test as an offender.
      "packages/novaclaw/test/project/worktree-remove.test.ts",
      "packages/novaclaw/test/git/git.test.ts",
      "packages/novaclaw/test/effect/instance-state.test.ts",
      "packages/novaclaw/test/server/project-copy.test.ts",
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
    // Take `tmpdir({ git: true })` / `tmpdirScoped({ git: true })` from `test/fixture/fixture.ts`.
    // If your setup genuinely is not that shape, extend the fixture — and only if you cannot, add an
    // entry to LEDGER above WITH ITS REASON, and expect that reason to be read.
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
    const fixture = sources.find((file) => file.name === "packages/novaclaw/test/fixture/fixture.ts")
    expect(fixture, "packages/novaclaw/test/fixture/fixture.ts vanished from the sweep").toBeDefined()
    expect(missingReuseMarkers(fixture!.text), "fixture.ts no longer memoizes + copies").toEqual([])
  })

  test("BOTH entry points provision git through the one shared function", () => {
    const fixture = sources.find((file) => file.name === "packages/novaclaw/test/fixture/fixture.ts")
    expect(entryPointsMissingProvision(fixture!.text)).toEqual([])
    // Exactly one `git init` may exist in the whole fixture: the template build. A second would mean
    // one of the entry points grew its own ritual back while still calling `provisionGit`.
    expect(fixture!.text.match(/\bgit\s+init(?![.\w])|["']init["']/g) ?? []).toHaveLength(1)
  })
})

describe("the guard actually bites (negative control)", () => {
  test("each shape matches the copy it was written for", () => {
    // The spellings that were live in this tree on 2026-07-28, plus the two argv forms.
    expect(shapesIn("await $`git init`.cwd(dirpath).quiet()")).toContain("a hand-rolled `git init`")
    expect(shapesIn("yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)")).toContain(
      "a hand-rolled `git init`",
    )
    expect(shapesIn(`await gitExec(directory, "init")`)).toContain("a hand-rolled `git init`")
    expect(shapesIn(`await exec("git", ["init"], { cwd })`)).toContain("a hand-rolled `git init`")
    expect(shapesIn(`yield* git("init")`)).toContain("a hand-rolled `git init`")
    expect(shapesIn("await $`git config user.email test@novaclaw.test`.cwd(dir).quiet()")).toContain(
      "the `user.email` / `user.name` fixture identity ritual",
    )
    expect(shapesIn(`await gitExec(directory, "config", "user.name", "Test")`)).toContain(
      "the `user.email` / `user.name` fixture identity ritual",
    )
  })

  test("it does NOT fire on the collapsed form, on scenario git, or on prose about it", () => {
    // The collapsed shape must be silent, or every fixed suite would land straight back in the ledger.
    expect(shapesIn(`await using tmp = await tmpdir({ git: true })`)).toEqual([])
    expect(shapesIn(`const dir = yield* tmpdirScoped({ git: true })`)).toEqual([])
    // Scenario git — the calls that ARE the subject — must stay invisible to this guard.
    expect(shapesIn("await $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet()")).toEqual([])
    expect(shapesIn("await $`git commit --allow-empty --amend -m ${message}`.cwd(dir).quiet()")).toEqual([])
    expect(shapesIn("await $`git checkout -b feature/test`.cwd(tmp.path).quiet()")).toEqual([])
    // ⚠️ `git config init.defaultBranch` is live in `test/git/git.test.ts` and starts with `git init`
    // as far as a lazy regex is concerned. It is configuration, not repository creation.
    expect(shapesIn("await $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet()")).toEqual([])
    expect(shapesIn("await $`git config core.fsmonitor true`.cwd(dir).quiet()")).toEqual([])
    // A digit-suffixed identifier must not read as the identity ritual.
    expect(shapesIn(`const user = { name: "Test" }`)).toEqual([])
    // …and a file that only TALKS about the old ritual is code-clean, because comments are stripped.
    expect(shapesIn(stripComments("// this used to run git init and git config user.email\nconst x = 1"))).toEqual([])
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The offender predicate itself, exercised on a synthetic file: the real sweep asserts an EMPTY
    // list, which alone cannot show that a non-empty one is reachable.
    const synthetic: Source = {
      name: "packages/novaclaw/test/server/rogue.test.ts",
      text: "await $`git init`.cwd(dir).quiet()\nawait $`git config user.email test@novaclaw.test`.cwd(dir).quiet()",
    }
    const offenders = [synthetic]
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
    expect(offenders).toEqual([
      "packages/novaclaw/test/server/rogue.test.ts → a hand-rolled `git init`, the `user.email` / `user.name` fixture identity ritual",
    ])
  })

  test("a fixture that stopped memoizing is what the reuse pin reports", () => {
    // The other direction, exercised on a synthetic fixture: the real test asserts an EMPTY list of
    // missing markers, which alone cannot show that a non-empty one is reachable. This body rebuilds
    // on every call — the regression the pin exists to catch.
    const regressed = `async function provisionGit(dir: string) {
      await gitExec(dir, "init")
      return dir
    }`
    expect(missingReuseMarkers(regressed)).toEqual(["gitTemplate ??=", "fs.cp(", "preserveTimestamps: true"])
    // …and the real fixture is the control in the other direction.
    const fixture = sources.find((file) => file.name === "packages/novaclaw/test/fixture/fixture.ts")
    expect(missingReuseMarkers(fixture!.text)).toEqual([])
  })

  test("an entry point that grew its own ritual back is what the shared-path pin reports", () => {
    // The specific regression the deleted "keep these in sync" comment could not prevent: one entry
    // point still calls the shared function, the other quietly re-inlines the ritual.
    const drifted = `export async function tmpdir<T>(options?: TmpDirOptions<T>) {
      if (options?.git) await provisionGit(dirpath)
    }
    export function tmpdirScoped<E = never, R = never>(options?: { git?: boolean }) {
      if (options?.git) {
        yield* git("config", "user.email", "test@novaclaw.test")
      }
    }
    export const provideInstance = 0`
    expect(entryPointsMissingProvision(drifted)).toEqual(["tmpdirScoped (no longer calls provisionGit)"])
    // A renamed or deleted entry point must fail loudly rather than silently pass an empty check.
    expect(entryPointsMissingProvision("const nothing = 1")).toEqual([
      "tmpdir (could not be located in fixture.ts — update this guard)",
      "tmpdirScoped (could not be located in fixture.ts — update this guard)",
    ])
  })
})
