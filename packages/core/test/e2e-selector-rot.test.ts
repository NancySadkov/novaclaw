import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The Playwright tier is the one test surface the gate cannot see, so it needs a guard the gate CAN.
 *
 * `packages/app/e2e` is not run by `bun run test` (`test:e2e` is a separate `playwright test` script,
 * invoked by nothing in the tree — no CI, no `.bat`, no turbo task; only `packages/app/README.md`
 * mentions it) and it is not compiled by `bun run typecheck` either: `packages/app/tsconfig.json`
 * includes `src` only, and `e2e/tsconfig.json` is referenced by no project. So a spec there could rot
 * in BOTH directions — broken assertions and broken imports — without one red line anywhere.
 *
 * It did. Commit 48a48b511 (2026-07-05) deleted the V1 virtualized render tree, and with it every
 * `data-timeline-row` / `data-timeline-part-id` / `data-timeline-key` / `data-timeline-virtual-content`
 * the timeline specs steer by; `home-project-row` went on 2026-07-06 and `home-session-search` on
 * 2026-07-09. Eight specs and a whole benchmark tier could not have passed for three and a half weeks,
 * and nothing said so. Those files were deleted on 2026-07-29 and this is what stops it recurring —
 * ruling 1: an invariant whose violation compiles green ships with a mechanical check, or it does not
 * exist. It lives in `packages/core/test` for the same reason `version-single-source.test.ts` does:
 * that is where a repo-shaped invariant gets to run in the default tier.
 *
 * ⚠️ Two traps this file is written around, both hit while measuring the original rot.
 *
 * 1. **CSS does not count as a renderer.** `[data-slot="bash-pre"]` and
 *    `[data-slot="basic-tool-tool-subtitle"]` still appear in `session-ui/src/components/*.css`, so a
 *    sweep that greps "the source tree" calls them live — they are orphaned style rules for markup
 *    nothing emits. The corpus below is TS/TSX only, deliberately.
 * 2. **A test file is not a renderer either.** A `*.test.ts(x)` may name a selector while asserting
 *    ABOUT it; that proves nothing about the DOM. Excluded for the same reason.
 *
 * What this does NOT check: visible-text and role assertions. `getByText("…")` rots too, and no static
 * check can settle it (i18n, fixture-supplied copy). Selectors are the mechanical half; they are also
 * the half that rotted.
 */

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const E2E = path.join(ROOT, "packages", "app", "e2e")
const RENDER_ROOTS = ["packages/app/src", "packages/session-ui/src", "packages/ui/src"]

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test-results" || entry.name === "playwright-report") continue
      walk(full, out)
    } else out.push(full)
  }
  return out
}

const rel = (file: string) => path.relative(ROOT, file).replaceAll(path.sep, "/")

/**
 * If the Playwright tier is ever deleted outright, this guard has nothing to guard — it must say so
 * and stop, not crash `core` with an ENOENT from a walk of a directory that is gone.
 */
const tierExists = fs.existsSync(E2E)

/** Every file Playwright would load: the specs plus the helpers they import. */
const e2eFiles = tierExists ? walk(E2E).filter((file) => file.endsWith(".ts")) : []

/**
 * What the product actually renders. TS/TSX only, tests excluded — see the traps above.
 */
const renderSource = RENDER_ROOTS.flatMap((root) => walk(path.join(ROOT, root)))
  .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n")

type Selector = { attribute: string; value?: string; where: string }

/** `[data-x="y"]`, `[data-x]`, `toHaveAttribute("data-x", …)` and `getByTestId("y")`. */
function selectorsIn(text: string, where: string): Selector[] {
  const found: Selector[] = []
  for (const match of text.matchAll(/\[data-([a-z-]+)(?:=["']([^"']*)["'])?\]/g))
    found.push({ attribute: `data-${match[1]}`, ...(match[2] === undefined ? {} : { value: match[2] }), where })
  for (const match of text.matchAll(/toHaveAttribute\(\s*["'`]data-([a-z-]+)["'`]/g))
    found.push({ attribute: `data-${match[1]}`, where })
  for (const match of text.matchAll(/getByTestId\(\s*["'`]([^"'`]+)["'`]/g))
    found.push({ attribute: "data-testid", value: match[1], where })
  return found
}

const selectors = e2eFiles.flatMap((file) => selectorsIn(fs.readFileSync(file, "utf8"), rel(file)))

/** A value built from a template hole (`${id}`) can only be checked at the attribute level. */
const isDynamic = (value: string | undefined) => value === undefined || value.includes("${")

function isRendered(selector: Selector) {
  if (isDynamic(selector.value)) return renderSource.includes(selector.attribute)
  const value = selector.value!
  return (
    renderSource.includes(`"${value}"`) || renderSource.includes(`'${value}'`) || renderSource.includes(`\`${value}\``)
  )
}

describe("packages/app/e2e cannot rot unnoticed", () => {
  test("every selector an e2e file steers by is rendered by TS/TSX in app, session-ui or ui", () => {
    const dead = selectors
      .filter((selector) => !isRendered(selector))
      .map((selector) =>
        selector.value === undefined
          ? `[${selector.attribute}] (${selector.where})`
          : `[${selector.attribute}="${selector.value}"] (${selector.where})`,
      )
    expect(
      [...new Set(dead)].sort(),
      "These e2e selectors are rendered by nothing in packages/app/src, packages/session-ui/src or\n" +
        "packages/ui/src. The spec asserting on them CANNOT pass, and nothing else will tell you:\n" +
        "the Playwright tier is neither run nor typechecked by `bun run test`.\n" +
        "Fix by re-authoring the spec against what the UI renders now, or by deleting it.\n" +
        "⚠️ Do NOT relax the assertion to whatever the DOM happens to have — that turns a rotted\n" +
        "test into a vacuous one, which is worse. And a match in a .css file is NOT a renderer.",
    ).toEqual([])
  })

  test("no helper under e2e/ is orphaned — every module is reachable from a spec", () => {
    const specs = e2eFiles.filter((file) => file.endsWith(".spec.ts"))
    const reachable = new Set<string>()
    const visit = (file: string) => {
      if (reachable.has(file)) return
      reachable.add(file)
      const text = fs.readFileSync(file, "utf8")
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]!)
        for (const candidate of [target, `${target}.ts`, path.join(target, "index.ts")])
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            visit(candidate)
            break
          }
      }
    }
    specs.forEach(visit)
    const orphans = e2eFiles.filter((file) => !reachable.has(file) && !file.endsWith("playwright.config.ts")).map(rel)
    expect(
      orphans.sort(),
      "These files sit under packages/app/e2e but no spec imports them, directly or transitively.\n" +
        "A probe whose only benchmark was deleted is dead weight that still reads as coverage.",
    ).toEqual([])
  })

  // Guards the guards: an extractor that silently stopped matching would make both lists empty and
  // report a rotted tier as clean. These numbers are floors, not budgets — raise them, never lower.
  test("the sweep is not vacuous", () => {
    if (!tierExists) {
      // Deleting the tier is a legitimate end state; a guard that then reports green over an empty
      // corpus is not. Fail loudly so whoever removed it also removes this file.
      throw new Error(`packages/app/e2e no longer exists — delete ${rel(import.meta.path)} with it.`)
    }
    expect(e2eFiles.length).toBeGreaterThanOrEqual(10)
    expect(selectors.length).toBeGreaterThanOrEqual(30)
    expect(renderSource.length).toBeGreaterThan(1_000_000)
    // A selector that IS rendered, so a corpus that silently went empty fails here rather than passing.
    expect(isRendered({ attribute: "data-component", value: "session-composer", where: "self-check" })).toBe(true)
    // …and one that is NOT, so `isRendered` returning true for everything fails here too. This exact
    // value was asserted on by `first-navigation-benchmark.spec.ts` while nothing rendered it.
    expect(isRendered({ attribute: "data-component", value: "task-tool-card", where: "self-check" })).toBe(false)
  })
})
