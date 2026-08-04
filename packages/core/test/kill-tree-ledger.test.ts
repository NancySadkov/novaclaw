import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **There is exactly ONE process-tree kill in this repository**, and this is the check that makes
 * that sentence true rather than aspirational.
 *
 * ⚠️ Why a guard and not a review. "Nobody hand-rolls a tree kill" is a claim about code in files
 * other than the one it is written in — the defect class that compiles green, so a review is the
 * wrong instrument (todo.md, standing decision 2: an invariant without a mechanical check does not
 * exist). By 2026-07-28 there were **ten** independent copies, every one of them written by someone
 * who had read the rule, and each with its own hole:
 *   · a pid interpolated into an `exec` SHELL STRING (`cross-spawn-spawner.ts`);
 *   · a `taskkill` spawned and never awaited (`jh/process-runner.ts`);
 *   · a POSIX branch that was a bare `proc.kill()`, i.e. the ROOT only (`novaclaw/src/util/process.ts`);
 *   · a win32-only kill whose POSIX leg orphaned the whole tree (`cli/cmd/serve.ts`);
 *   · a group signal with no SIGKILL escalation (`app/scripts/dev-with-backend.ts`);
 *   · several with no ppid snapshot, so a descendant in its own group survived.
 * What it costs when one of those holes is hit is not abstract: on 2026-07-20 accumulated orphans
 * pinned commit charge at 99.9% of a 68 GB ceiling for 24+ hours and hard-crashed this laptop
 * (AGENTS.md → *Known pitfalls* #8, "NO ZOMBIES ALLOWED").
 *
 * So: any file that names `taskkill`, signals a process GROUP, passes the Windows `/T /F` tree flags
 * or probes for descendants must be **in the ledger below, with a reason**. The ledger is a RATCHET —
 * it fails in both directions. A new site fails outright; a listed site that no longer has one fails
 * with "drop the ledger entry", so a fix forces the entry out and the list can only shrink.
 *
 * The one thing this test cannot see is whether a kill WORKS. That is
 * `test/shell-kill-tree.test.ts`, which spawns real trees and asserts on the GRANDCHILD.
 */

/** The app repo root: `packages/core/test` → `packages/core` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

/** Everything that ships or builds. `packages/**` is the product; `script/**` is the build tooling. */
const SCAN_ROOTS = ["packages", "script"] as const

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "gen", // generated SDK client — never hand-edited (AGENTS.md → Known pitfalls #7)
  ".git",
  ".turbo",
  ".vite",
  "playwright-report",
  "test-results",
])

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

/**
 * This file itself. It quotes every shape it hunts for, so without this it would be its own first
 * offender. Excluded by name rather than by a magic marker comment, because a marker in a source file
 * would be an opt-out anyone could paste.
 */
const SELF = "packages/core/test/kill-tree-ledger.test.ts"

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so this answers "does this file DO it", never "does it mention
   *  it" — the collapsed sites all explain in prose what they used to hand-roll. */
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

const sources = SCAN_ROOTS.reduce<Source[]>((acc, root) => collect(path.join(ROOT, root), acc), [])

/**
 * The shapes a hand-rolled process-tree kill takes. Each is the *mechanism*, not a name a refactor
 * could rename away.
 */
const SHAPES: ReadonlyArray<{ readonly what: string; readonly re: RegExp }> = [
  // The only thing on Windows that reaches grandchildren — and therefore the only thing anyone
  // hand-rolls there. Catches both the argv-array form and the `exec` shell-string form.
  { what: "taskkill", re: /\btaskkill\b/i },
  // `process.kill(-pid, …)` / `proc.kill(-pid)` — signalling a POSIX process GROUP.
  { what: "a process-group signal", re: /\bkill\(\s*-/ },
  // `/T /F` (or `/F /T`) in either order, as separate argv strings or inside one shell string.
  { what: "the Windows /T /F tree flags", re: /\/[tT]\b[^\n]{0,12}\/[fF]\b|\/[fF]\b[^\n]{0,12}\/[tT]\b/ },
  // Walking the process table to find descendants by hand.
  { what: "a descendant probe", re: /\bpgrep\b|\bParentProcessId\b/ },
]

const shapesIn = (text: string): string[] => SHAPES.filter((shape) => shape.re.test(text)).map((shape) => shape.what)

/**
 * ─── the ledger ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every file allowed to contain a tree-kill shape, and WHY. Ordered: the canonical implementation
 * first, then the sanctioned duplicate, then the outstanding ones.
 *
 * ⚠️ Adding an entry here is a decision with a cost — it is one more place that can rot into the
 * next 68 GB night. Collapse onto `Shell.killTree` / `Shell.killTreeSync` (or the leaf spelling,
 * `@novaclaw/core/util/kill-tree`) unless the import is genuinely impossible, and say so in the reason.
 */
const LEDGER = new Map<string, string>([
  [
    "packages/core/src/util/kill-tree.ts",
    "THE implementation. A leaf module importing `node:` builtins and nothing else, so the jh engine " +
      "can take it without violating §0.7.2 (jh/imports.test.ts). Re-exported as `Shell.killTree` / " +
      "`Shell.killTreeSync`. Behaviour is asserted against real process trees in shell-kill-tree.test.ts.",
  ],
  // `packages/sdk/js/src/process.ts` was ledgered here as "the ONE sanctioned duplicate (coordinator
  // ruling, 2026-07-28)", justified by the SDK declaring `cross-spawn` "on purpose". That ruling was
  // in direct conflict with todo.md's standing decision of the SAME day — "`@novaclaw/sdk` carries
  // ZERO runtime dependencies" — which is the binding one. Resolved 2026-07-29 by deleting the thing
  // both were arguing about: `src/v2/server.ts` (the only importer of `process.ts`) is gone, so the
  // SDK spawns nothing, `process.ts` went with it, and the entry was forced out of this ledger by the
  // fix — which is exactly what a shrink-only ledger is for.
  [
    "packages/desktop/scripts/smoke-artifact.ts",
    "`packages/desktop` deliberately declares NO `@novaclaw/core` dependency — its own scripts/utils.ts " +
      "says so in as many words ('so these build scripts need no dependency on the kernel'), and " +
      "src/main/index.ts refuses one for six lines of code. This script also runs against a PACKAGED exe " +
      "from outside the workspace graph, and it is step 4 of both build scripts (a non-zero exit fails " +
      "the build). Collapsing it means adding that dependency edge, which is a packaging decision, not a " +
      "cleanup. Its own kill is win32 `taskkill /f /t` + POSIX group SIGKILL: correct on Windows, and on " +
      "POSIX missing the ppid snapshot and the grace window.",
  ],
  [
    "script/test.ts",
    "`reapOrphans` — the test harness's own orphan reaper, and the reason a wall-clock-killed unit no " +
      "longer poisons the next one (a leaked bun child holding 4.89 GB, 2026-07-27). Three reasons it " +
      "stays: (a) `script/` declares only dev dependencies (it became the `@novaclaw/repo-script` " +
      "workspace on 2026-07-29 purely so it gets typechecked), so `@novaclaw/core` would be a new " +
      "runtime edge from the harness into the kernel — which is reason (b) restated; (b) the " +
      "harness must not import the code it tests — a broken `core` would then crash `bun run test` at " +
      "import instead of reporting `core FAIL`; (c) it is synchronous throughout, inside a spawnSync " +
      "loop. Breaking it would make every later verification in this program untrustworthy.",
  ],
  [
    "packages/novaclaw/test/lib/cli-process.ts",
    "Test helper for the CLI integration suites. Not collapsed in Wave 1 (out of the C2 file " +
      "ownership); a win32-only `Bun.spawnSync` taskkill, so its POSIX leg is root-only. FILED.",
  ],
  [
    "packages/core/test/util/flock.test.ts",
    "Kills the lock-holder child it spawned. Not collapsed in Wave 1 (out of the C2 file ownership). FILED.",
  ],
  [
    "packages/core/test/util/effect-flock.test.ts",
    "Same as flock.test.ts — the Effect-flavoured twin of that suite. FILED.",
  ],
])

/** The sites Wave 1 collapsed. Each must still reach the canonical kill, or the collapse regressed. */
const COLLAPSED: ReadonlyArray<readonly [string, RegExp]> = [
  ["packages/core/src/cross-spawn-spawner.ts", /\bkillTree(?:Sync)?\(/],
  ["packages/core/src/jh/process-runner.ts", /\bkillTree\(/],
  ["packages/core/src/pty.ts", /\bkillTreeSync\(/],
  ["packages/novaclaw/src/util/process.ts", /\bShell\.killTree\(/],
  ["packages/novaclaw/src/cli/cmd/serve.ts", /\bkillTreeSync\(/],
  ["packages/app/scripts/dev-with-backend.ts", /\bkillTreeSync\(/],
]

describe("the sweep", () => {
  test("actually has the repository to look at", () => {
    // A mistyped root, a moved test file or a bad SKIP_DIRS entry would silently empty the sweep and
    // turn every assertion below into a tautology.
    expect(sources.length).toBeGreaterThan(1_000)
  })

  test("reaches every package that has ever held a tree kill, plus the build tooling", () => {
    const names = new Set(sources.map((file) => file.name))
    for (const name of [
      "packages/core/src/util/kill-tree.ts",
      "packages/core/src/cross-spawn-spawner.ts",
      "packages/novaclaw/src/util/process.ts",
      "packages/app/scripts/dev-with-backend.ts",
      "packages/desktop/scripts/smoke-artifact.ts",
      "script/test.ts",
    ])
      expect(names, `${name} is not in the sweep`).toContain(name)
  })
})

describe("there is exactly ONE process-tree kill", () => {
  test("no unledgered file hand-rolls one", () => {
    const offenders = sources
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
      .sort()
    // Route it through `Shell.killTree` (async) or `Shell.killTreeSync` (a `process.on("exit")` hook,
    // an `Effect.sync` finalizer, anything that calls process.exit on the next line). If you genuinely
    // cannot import it, add an entry to LEDGER above WITH ITS REASON — and expect that reason to be read.
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
        stale.push(`${name} (no longer hand-rolls a tree kill — drop the ledger entry)`)
    }
    expect(stale).toEqual([])
  })

  test("the canonical implementation is the one the ledger points at", () => {
    const canonical = sources.find((file) => file.name === "packages/core/src/util/kill-tree.ts")
    expect(canonical, "packages/core/src/util/kill-tree.ts vanished from the sweep").toBeDefined()
    // It must actually contain the mechanisms — a stub that satisfied the ledger while killing
    // nothing is the "reads as coverage while being none" failure this whole file exists to remove.
    // Both platform legs, by shape: `taskkill /f /t` on win32 and the process-group signal on POSIX.
    const found = shapesIn(canonical!.text)
    expect(found).toContain("taskkill")
    expect(found).toContain("a process-group signal")
    expect(found).toContain("the Windows /T /F tree flags")
    for (const marker of ["export async function killTree", "export function killTreeSync"])
      expect(canonical!.text, `kill-tree.ts no longer exports ${marker}`).toContain(marker)
  })

  test("`Shell` still re-exports it under the name the rest of the tree imports", () => {
    const shell = sources.find((file) => file.name === "packages/core/src/shell.ts")
    expect(shell, "packages/core/src/shell.ts vanished from the sweep").toBeDefined()
    expect(shell!.text).toContain("./util/kill-tree")
    for (const name of ["killTree", "killTreeSync", "descendantsOf"])
      expect(shell!.text, `Shell no longer re-exports ${name}`).toContain(name)
  })

  test("every site Wave 1 collapsed still reaches the canonical kill", () => {
    // The other direction of the ratchet: deleting the call (rather than replacing it) would pass the
    // offender sweep above while silently restoring the root-only kill.
    const regressed: string[] = []
    for (const [name, expected] of COLLAPSED) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        regressed.push(`${name} (missing from the sweep)`)
        continue
      }
      if (!expected.test(file.text)) regressed.push(`${name} (no longer calls ${String(expected)})`)
    }
    expect(regressed).toEqual([])
  })
})

describe("the guard actually bites (negative control)", () => {
  test("each shape matches the copy it was written for", () => {
    expect(shapesIn(`spawn("taskkill", ["/pid", String(pid), "/f", "/t"])`)).toContain("taskkill")
    expect(shapesIn("exec(`taskkill /pid ${proc.pid} /T /F`)")).toContain("taskkill")
    expect(shapesIn(`process.kill(-child.pid, "SIGKILL")`)).toContain("a process-group signal")
    expect(shapesIn(`proc.kill( -pid )`)).toContain("a process-group signal")
    expect(shapesIn(`spawnSync("nokill", ["/T", "/F", "/PID", String(child)])`)).toContain(
      "the Windows /T /F tree flags",
    )
    expect(shapesIn(`spawnSync("pgrep", ["-P", String(pid)])`)).toContain("a descendant probe")
    expect(shapesIn(`Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid"`)).toContain("a descendant probe")
  })

  test("it does NOT fire on the correct thing, or on prose about it", () => {
    // The collapsed shape must be silent, or every fixed site would land straight back in the ledger.
    expect(shapesIn(`await Shell.killTree(proc, { exited })`)).toEqual([])
    expect(shapesIn(`killTreeSync(child.pid)`)).toEqual([])
    expect(shapesIn(`handle.kill("SIGTERM")`)).toEqual([])
    expect(shapesIn(`await Shell.killTree(-1)`)).toEqual([])
    // `ripgrep` contains the letters of pgrep and must not trip the descendant probe.
    expect(shapesIn(`const files = yield* ripgrep.find({ cwd })`)).toEqual([])
    // …and a file that only TALKS about the old kill is code-clean, because comments are stripped.
    expect(shapesIn(stripComments(`// this used to run taskkill /T /F and process.kill(-pid)\nconst x = 1`))).toEqual(
      [],
    )
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The offender predicate itself, exercised on a synthetic file: the real sweep asserts an EMPTY
    // list, which alone cannot show that a non-empty one is reachable.
    const synthetic: Source = { name: "packages/somewhere/rogue.ts", text: `spawnSync("taskkill", ["/f", "/t"])` }
    const offenders = [synthetic]
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
    expect(offenders).toEqual(["packages/somewhere/rogue.ts → taskkill, the Windows /T /F tree flags"])
  })
})
