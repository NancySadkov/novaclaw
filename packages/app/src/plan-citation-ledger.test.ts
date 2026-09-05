import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * Shrink-only ledger for `todo/…` citations in shipped source.
 *
 * 🔴 The rule this enforces is not new and is not ours to soften: **a `todo/` path may never appear
 * in anything durable** — not a source comment, not a test, not a note. A todo is a WORKING file:
 * finished items are deleted from it and the whole file is deleted when its programme lands. So a
 * citation to `todo/x.md` is a reference with a scheduled expiry, and it expires exactly when the
 * work succeeds. Cite the durable thing instead — a `notes/` record, a `doc/` runbook, or the commit
 * (`git log -S <symbol>` finds it). Better still, delete the citation: a plan file is deleted
 * *because* its programme landed, so the code that landed IS the answer the pointer was aiming at.
 *
 * The rule was written down long before it had a lever, and the tree had drifted to **277 citations
 * across 174 files** when this ledger opened on 2026-09-01 — of which **158 named a `todo/` file
 * that no longer exists**. That is the failure the rule predicts, arriving on schedule. This ledger
 * is the lever: the counts below may only go DOWN.
 *
 * ⚠️ **"On 2026-09-01 they reached zero" was true of what this file LOOKED AT, and that is not the
 * same claim.** Re-measured later the same day, the lever had two blind spots, and between them they
 * hid **138 live citations** while every line read 0:
 *
 * 1. **SCOPE.** It scanned `packages/<pkg>/src` only. The rule it quotes says *"not a source comment,
 *    **not a test**"* — and **77** todo-file paths were sitting in each package's `test` and
 *    `script` directories, untouched by the burndown because nothing looked there. A guard whose
 *    scope is narrower than the rule it enforces reports the subset it can see as the whole.
 * 2. **SYNTAX.** It matches a PATH. The 2026-08-31 refactor sweep cites its ledger by ID instead —
 *    `RF-17-10`, `UX-05` — which is the identical expiring reference wearing different characters:
 *    the refactor ledger is deleted when its programme lands, and every id that named an entry in it
 *    becomes a pointer to nothing. **61** of those had accumulated.
 *
 * 🔴 **The second one is the more interesting failure, because the burndown CAUSED it.** Closing the
 * path form without closing the rule left the cheapest-to-type alternative wide open, and the very
 * next programme took it. A lever that pins one spelling teaches the next author a different
 * spelling.
 *
 * **So both forms are now counted, over `src` AND `test` AND `script`, and both may only go DOWN.**
 * The numbers below are what a real measurement returned, not an aspiration; `app` is 0 for paths
 * because that burndown genuinely finished there.
 *
 * ⚠️ **Why counts and not a bare zero to begin with.** Each site was a prose rewrite, not a
 * repoint — the citation usually carried a work-item id ("1e", "Phase 2", "§0.10") that meant
 * nothing once the file was gone, so deleting the path alone left an orphan mid-sentence. Where the
 * cited passage was a fact's only home the fact was kept and the pointer dropped; where a durable
 * successor existed the citation moved to it (`todo/projects.md` closed into AGENTS.md design
 * principle 13 plus `notes/reports/projects-program-2026-08-18.md`, and several sites now say so).
 *
 * ⚠️ **`notes/` and `doc/` are deliberately NOT counted here.** They are the *sanctioned* targets, so
 * counting them would penalise the correct move. They rot too (84 dead against 90 live at the same
 * measurement) but the check for that cannot live in this repo: `packages/<pkg>/src` ships in the app
 * repo, while `todo/`, `notes/` and `doc/` live in the plan repo, which the app repo does not
 * contain and never will. A resolve-check here would call every citation dead.
 *
 * **When you clean one up:** lower its package's number. A stale entry fails as loudly as a new
 * citation, so this cannot rot into a rubber stamp.
 */

const PACKAGES_DIR = resolve(import.meta.dir, "..", "..")
const SELF = resolve(import.meta.dir, "plan-citation-ledger.test.ts")

/** `todo/<file>.md` anywhere in a source file. There is no legitimate code use of such a path. */
const PATH_CITATION = /\btodo\/[A-Za-z0-9._-]+\.md/g

/**
 * A refactor-sweep ledger ID — `RF-29-15`, `UX-05`. Same expiry as a todo path and none of the
 * visibility: these name entries inside the refactor ledger, which is deleted when it lands.
 *
 * ⚠️ Narrow ON PURPOSE. It matches the sweep’s two id shapes and nothing else, so an ordinary
 * identifier, a hex string or a date cannot be swept up — a ratchet that fires on innocent code
 * gets its numbers raised until it means nothing.
 */
const ID_CITATION = /\b(?:RF-\d{2}-\d+[a-z]?|UX-\d{2})\b/g

/**
 * Measured 2026-09-01 over `src` + `test` + `script`. Both numbers may only DECREASE.
 * A package that reaches 0 keeps its line at 0 — a package with no line at all fails the roster test.
 */
const LEDGER: Record<string, { paths: number; ids: number }> = {
  app: { paths: 0, ids: 0 },
  core: { paths: 0, ids: 0 },
  desktop: { paths: 0, ids: 0 },
  dht: { paths: 0, ids: 0 },
  "effect-drizzle-sqlite": { paths: 0, ids: 0 },
  host: { paths: 0, ids: 0 },
  "http-recorder": { paths: 0, ids: 0 },
  llm: { paths: 0, ids: 0 },
  novaclaw: { paths: 0, ids: 0 },
  plugin: { paths: 0, ids: 0 },
  protocol: { paths: 0, ids: 0 },
  schema: { paths: 0, ids: 0 },
  script: { paths: 0, ids: 0 },
  server: { paths: 0, ids: 0 },
  "session-ui": { paths: 0, ids: 0 },
  ui: { paths: 0, ids: 0 },
  watchdog: { paths: 0, ids: 0 },
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  // Not every package has all three roots; a missing one contributes nothing rather than throwing.
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "out" || entry === ".ts-dist") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full)
  }
  return acc
}

function scan(): { counts: Record<string, { paths: number; ids: number }>; sites: string[]; files: number } {
  const counts: Record<string, { paths: number; ids: number }> = {}
  const sites: string[] = []
  let files = 0
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src")
    let isDir = false
    try {
      isDir = statSync(src).isDirectory()
    } catch {
      isDir = false
    }
    // `src` is what makes something a package here; `test` and `script` are scanned because the rule
    // says "not a source comment, NOT A TEST", and scanning only `src` is what let 77 of them hide.
    if (!isDir) continue
    counts[pkg] = { paths: 0, ids: 0 }
    for (const root of ["src", "test", "script"])
      for (const file of sourceFiles(join(PACKAGES_DIR, pkg, root))) {
        // ⚠️ The ledger must not count ITSELF. This file quotes both forms to state the rule, and a
        // scanner that matches its own prose reports violations it can never clear.
        if (file === SELF) continue
        files++
        const text = readFileSync(file, "utf8")
        const paths = (text.match(PATH_CITATION) ?? []).length
        const ids = (text.match(ID_CITATION) ?? []).length
        if (paths === 0 && ids === 0) continue
        counts[pkg]!.paths += paths
        counts[pkg]!.ids += ids
        sites.push(`${relative(PACKAGES_DIR, file).replaceAll("\\", "/")} (paths ${paths}, ids ${ids})`)
      }
  }
  return { counts, sites, files }
}

describe("plan-citation ledger", () => {
  test("every package with a src/ has a ledger line", () => {
    const { counts } = scan()
    expect(Object.keys(counts).sort()).toEqual(Object.keys(LEDGER).sort())
  })

  test("neither citation form grew, and no ledger line is stale", () => {
    const { counts } = scan()
    const drift: string[] = []
    for (const [pkg, allowed] of Object.entries(LEDGER)) {
      const actual = counts[pkg] ?? { paths: 0, ids: 0 }
      // The two forms are reported separately on purpose: they are cleaned up by different edits,
      // and a combined total would let a new id hide behind a removed path.
      for (const form of ["paths", "ids"] as const) {
        const got = actual[form]
        const cap = allowed[form]
        if (got === cap) continue
        drift.push(
          got > cap
            ? `${pkg}: ${got} ${form}-form plan citations, ledger allows ${cap}. Such a citation expires when the work lands — cite notes/, doc/, or the commit, or just say the thing.`
            : `${pkg}: ${got} ${form}-form plan citations, ledger still says ${cap}. Lower it to ${got}.`,
        )
      }
    }
    expect(drift).toEqual([])
  })

  test("the scan is reading real files (vacuity)", () => {
    // ⚠️ Every count above is a `.match()` on text read from disk. A widened-but-broken root, or a
    // `sourceFiles` that silently returns nothing, makes every number 0 and every assertion agree
    // with itself forever. The file-population floor is the proof it is still looking even after the
    // citation burndown reaches zero; a nonzero violation is no longer required for a healthy tree.
    const { counts, files } = scan()
    expect(Object.keys(counts).length).toBeGreaterThan(10)
    expect(files, "no source files found — the scan reached nothing").toBeGreaterThan(100)
  })
})
