import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * **The shrink-only ledger of per-test timeout overrides in `packages/core/test/`.**
 *
 * `script/test.ts` gives every test in this package **15 s** and calls it a stuck-test guard. Two
 * tests now run on a larger budget because 15 s stopped being a guard for them and became a coin
 * flip — the derivations live in the files themselves, each with the measurement it came from.
 *
 * 🔴 **This exists because of the specific way that decision goes wrong.** ``:
 * *"a timeout that was tuned and then doubled after a failure is how a real race gets papered
 * over."* The failure mode is not the first raise, which someone reasons about; it is the second and
 * third, each one line, each individually defensible, none of them measured. A number nobody has to
 * defend in a diff is a number that only ever goes up — so the numbers are pinned HERE, and raising
 * one means editing a ledger that says out loud what it is for.
 *
 * **What it enforces**, over comment-stripped source so prose can never be counted as code
 * (`` — three wrong numbers landed in one day from regexes that matched
 * comments):
 *
 *   1. Exactly the files below carry a `BUDGET_MS`, and none exceeds its pin.
 *   2. No other file under `test/` declares one — a raised budget cannot appear unlisted.
 *   3. Those files contain **no other** numeric literal above the 15 s default, which is what closes
 *      the obvious bypass: passing `90_000` straight to `test(…)` instead of naming a constant.
 *
 * ⚠️ **Rule 3 is scoped to the ledgered files on purpose.** Repo-wide it would be noise — 156
 * literals of that size already live under `test/`, nearly all of them byte sizes and product
 * durations. Precision here beats a repo-wide net nobody could keep green.
 */

const CORE = path.resolve(import.meta.dir, "..")

/** The suite-wide per-test timeout, from `script/test.ts`'s `PER_TEST_TIMEOUT_MS`. */
const SUITE_DEFAULT_MS = 15_000

/**
 * file (relative to `packages/core`) → the largest budget it may declare.
 *
 * ⚠️ **Shrink-only.** A new entry, or a larger number on an existing one, is a deliberate edit to
 * this table and belongs in a commit that states the measurement behind it.
 */
const LEDGER: Readonly<Record<string, number>> = {
  "test/npm.test.ts": 60_000,
  "test/repository-cache.test.ts": 60_000,
}

/** This file necessarily names the identifier it is guarding. */
const SELF = path
  .relative(CORE, import.meta.path)
  .split(path.sep)
  .join("/")

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])

const DECLARATION = /\bconst\s+BUDGET_MS\s*=\s*([0-9][0-9_]*)\b/g
/** Every integer literal, `_` separators allowed; the size filter is applied after parsing, not by the regex. */
const INTEGER_LITERAL = /\b[0-9][0-9_]*\b/g

function testFiles(dir: string, out: { name: string; text: string }[] = []): { name: string; text: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) testFiles(full, out)
      continue
    }
    if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue
    const name = path.relative(CORE, full).split(path.sep).join("/")
    if (name === SELF) continue
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

const files = testFiles(path.join(CORE, "test"))

const declarations = new Map<string, number[]>()
for (const file of files) {
  const found = [...file.text.matchAll(DECLARATION)].map((match) => Number(match[1].replaceAll("_", "")))
  if (found.length > 0) declarations.set(file.name, found)
}

describe("per-test budget ledger", () => {
  test("the suite found files to read", () => {
    // A path typo would make every assertion below vacuously true — the "reads as coverage while
    // being none" shape this repo's ledgers exist to remove.
    expect(files.length).toBeGreaterThan(50)
  })

  test("exactly the ledgered files declare a per-test budget", () => {
    expect([...declarations.keys()].toSorted()).toEqual(Object.keys(LEDGER).toSorted())
  })

  test("no budget exceeds its pin", () => {
    for (const [name, values] of declarations) {
      const pin = LEDGER[name]
      expect(values).toHaveLength(1)
      if (values[0] > pin)
        throw new Error(
          `${name} declares BUDGET_MS = ${values[0]}, above its shrink-only pin of ${pin}.\n` +
            `Raising a per-test timeout is how a real race gets papered over. If the work honestly\n` +
            `costs more, say what measured it — in the file's header and in this table — and shrink\n` +
            `the number back once the cost comes down.`,
        )
    }
  })

  test("a ledgered file smuggles no larger number past its constant", () => {
    for (const name of Object.keys(LEDGER)) {
      const file = files.find((candidate) => candidate.name === name)
      expect(file, `${name} is ledgered but was not found on disk`).toBeDefined()
      const declared = declarations.get(name)?.[0]
      const offenders = [...file!.text.matchAll(INTEGER_LITERAL)]
        .map((match) => Number(match[0].replaceAll("_", "")))
        .filter((value) => value > SUITE_DEFAULT_MS && value !== declared)
      expect({ name, offenders }).toEqual({ name, offenders: [] })
    }
  })
})
