import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * BUILT-IN TILE IDENTITY MUST BE STABLE (review H2, 2026-08-23).
 *
 * 🔴 `useBuiltinApps()` returned `() => [ {...}, {...}, … ]` — a fresh array of fresh object literals
 * on EVERY call. `<For>` keys by reference, so any recomputation of the home screen's `apps` memo
 * gave every tile a new identity and solid disposed and recreated the whole grid instead of moving
 * nodes. Measured with solid's own `mapArray`: a drag-release went 3 tile mounts → 6. Each rebuilt
 * tile re-ran `createSortable()` — re-registering with solid-dnd MID-GESTURE — rebuilt its classList
 * effects and recreated its `<img>`. It fired on every reorder, and whenever an agent app registered
 * or a manifest loaded.
 *
 * ⚠️ This is a SOURCE ledger, and that is a deliberate second-best. `builtins.tsx` is a `.tsx` the
 * unit tier cannot load, and the property at stake — "the same call returns the same objects" — is
 * exactly the kind that compiles green either way and that nothing else in the tree would notice.
 * The A/B is real: reverting the array to a `return () => [` factory fails the first test here.
 */

const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "builtins.tsx"), "utf8").replace(
  /\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g,
  "$1 ",
)

describe("builtins.tsx", () => {
  test("🔴 the app array is built ONCE, not per call", () => {
    // A `return () => [` factory is the defect verbatim.
    expect(source).not.toMatch(/return\s*\(\s*\)\s*=>\s*\[/)
    expect(source).toMatch(/const apps:\s*HomeApp\[\]\s*=\s*\[/)
    expect(source).toMatch(/return\s*\(\s*\)\s*=>\s*apps/)
  })

  test("⚠️ the reactive fields stay reactive — as GETTERS, not frozen values", () => {
    // Stability must not be bought by freezing the language. `title`/`subtitle` read the language
    // context, so a plain value would pin the tile labels to whatever locale was active at mount.
    expect(source).toMatch(/get title\(\)/)
    expect(source).toMatch(/get subtitle\(\)/)
    expect(source).not.toMatch(/\btitle:\s*name\(/)
    expect(source).not.toMatch(/\bsubtitle:\s*sub\(/)
  })

  test("every built-in has both", () => {
    const ids = [...source.matchAll(/^\s{6}id:\s*"([a-z]+)"/gm)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(8)
    expect([...source.matchAll(/get title\(\)/g)].length).toBe(ids.length)
    expect([...source.matchAll(/get subtitle\(\)/g)].length).toBe(ids.length)
  })
})

describe("home-screen.tsx", () => {
  const home = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pages", "home-screen", "home-screen.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, "$1 ")

  test("🔴 PAGES are keyed by index, TILES by identity", () => {
    // `pages()` is a fresh array of fresh arrays on every recomputation and a page has no identity
    // beyond its position — `<For>` there disposed every page, and with it every tile inside, on
    // each drag-release. The tiles DO have identity, which is what the fix above restores.
    expect(home).toMatch(/<Index each=\{pages\(\)\}>/)
    // ⚠️ Narrow on purpose: the page DOTS legitimately iterate `pages()` with `<For>` and use
    // the index argument, and they render nothing that has identity. What must not come back
    // is a `<For each={pages()}>` whose child is the tile GRID.
    expect(home).not.toMatch(/<For each=\{pages\(\)\}>\s*\{\(pageApps/)
    expect(home).toMatch(/<For each=\{pageApps\(\)\}>/)
  })
})
