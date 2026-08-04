import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **ONE producer of the `novaclaw-core-test-*` temp namespace.**
 *
 * `test/fixture/tmpdir.ts` owns that prefix. It creates exactly one root per LIVE test process,
 * `novaclaw-core-test-pid<pid>/`, and on startup it REAPS every sibling root whose owning process is
 * gone — the only teardown mechanism there is, because `bun test` does not run `process.on("exit")`
 * handlers. That reap is why the namespace has to have a single owner:
 *
 *   · A second producer LEAKS. `test/effect/cross-spawn-spawner.test.ts` hand-rolled
 *     `mkdtemp(os.tmpdir(), "novaclaw-core-test-")` with no reap of its own, so a wall-clock kill or
 *     a crash left its directory behind forever. That is half of the 24 abandoned directories
 *     measured in `%TEMP%` on 2026-07-29 (dated 07-14 → 07-28, one per killed run).
 *   · A second producer can also be DELETED OUT FROM UNDER a live run. The fixture's reap parses
 *     whatever follows `novaclaw-core-test-pid` as a pid; `mkdtemp` appends exactly six characters,
 *     so `novaclaw-core-test-<6 chars>` was disjoint from it — but only by arithmetic nobody was
 *     holding in place. Shorten the fixture's infix, or lengthen a hand-rolled suffix, and an
 *     all-numeric name parses as a dead pid and a concurrent run's working directory disappears
 *     mid-test. Trading a leak for a flaky suite is a bad trade.
 *
 * Both hazards are invisible in a green run and neither fails loudly, which is todo.md ruling 1's
 * defect class exactly: an invariant about code outside its own file, with nothing to enforce it.
 * This is the enforcement. Other prefixes (`novaclaw-log-test-`, `kb-*`, …) are deliberately NOT in
 * scope — they collide with nothing; it is this prefix that has a reap pointed at it.
 */

const CORE = path.resolve(import.meta.dir, "..")

/** The file that owns the namespace, relative to `packages/core`. */
const OWNER = "test/fixture/tmpdir.ts"

/** This file necessarily names the prefix it is guarding. */
const SELF = path
  .relative(CORE, import.meta.path)
  .split(path.sep)
  .join("/")

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])

/** The prefix as it appears in a string literal of any quoting style. */
const CLAIMS_PREFIX = /["'`]novaclaw-core-test/

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string, out: { name: string; text: string }[]): { name: string; text: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out)
      continue
    }
    if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue
    const name = path.relative(CORE, full).split(path.sep).join("/")
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

/** Files that put the prefix in a string literal — i.e. that could CREATE such a directory. */
function producers(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  return files.filter((file) => file.name !== SELF && CLAIMS_PREFIX.test(file.text)).map((file) => file.name)
}

const sources = collect(CORE, [])

describe("the novaclaw-core-test-* temp namespace has exactly one producer", () => {
  test("the sweep reached this package", () => {
    expect(sources.length).toBeGreaterThan(200)
    expect(sources.map((file) => file.name)).toContain(OWNER)
    expect(sources.map((file) => file.name)).toContain("test/effect/cross-spawn-spawner.test.ts")
  })

  test("only the fixture names the prefix", () => {
    expect(
      producers(sources)
        .filter((name) => name !== OWNER)
        .map(
          (name) =>
            `${name} creates temp directories in the "novaclaw-core-test-" namespace that ` +
            `${OWNER} reaps. Use \`import { tmpdir } from ".../fixture/tmpdir"\` instead — a second ` +
            "producer either leaks (no reap of its own) or gets reaped out from under a live run.",
        ),
    ).toEqual([])
  })

  test("the guard actually bites (negative control)", () => {
    // A matcher that found nothing because it can find nothing would pass forever. Run it over
    // synthetic files covering the three shapes that matter.
    expect(
      producers([
        { name: "test/offender.test.ts", text: 'await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-core-test-"))' },
        { name: "test/converged.test.ts", text: 'import { tmpdir } from "../fixture/tmpdir"' },
        { name: "test/other-prefix.test.ts", text: 'await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-log-test-"))' },
      ]),
    ).toEqual(["test/offender.test.ts"])

    // Prose ABOUT the prefix is not a producer — `cross-spawn-spawner.test.ts` explains in a comment
    // why it stopped being one, and must not be flagged for saying so.
    expect(
      producers(
        [
          {
            name: "test/prose.test.ts",
            text: '// used to be mkdtemp(os.tmpdir(), "novaclaw-core-test-")\nconst x = 1',
          },
        ].map((file) => ({ ...file, text: stripComments(file.text) })),
      ),
    ).toEqual([])

    // …and the real file this was written for is one of the converged ones.
    expect(producers(sources)).toEqual([OWNER])
  })
})
