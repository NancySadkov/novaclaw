import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// Two invariants left behind by collapsing the `newLayoutDesigns` legacy shell (v0.2.0-prep §5).
// Both are the defect class standing decision 1 names: violating either compiles green.
//
//  1. The flag is GONE. It selected between two whole app shells, defaulted true, and had no
//     setter with a caller — so the legacy half was compiled and shipped for nobody. Re-introducing
//     "just one more" fork of a component on a boolean is what ruling 13 forbids ("one design
//     system; theme by remapping tokens, never by forking components").
//  2. The pre-tab URL shape STILL RESOLVES. `/<base64 directory>[/session[/<id>]]` used to be a real
//     route under the legacy shell. Deleting the shell without re-homing those routes would 404
//     every OS notification already sitting in a user's tray, every `novaclaw://` deep link, and
//     several in-app navigations — none of which are visible to a typecheck.

const SRC = path.resolve(import.meta.dir)

/** Every non-test source file under packages/app/src, as forward-slash relative paths. */
function sourceFiles(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .filter((rel) => fs.statSync(path.join(SRC, rel)).isFile())
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8")
}

/** Navigations/links that still emit the legacy directory URL shape. */
const LEGACY_HREF_PATTERNS = [/\$\{base64Encode\([^)]*\)\}\//, /\$\{params\.dir\}\//]

describe("the legacy app shell stays collapsed", () => {
  test("no source file mentions the newLayoutDesigns flag", () => {
    const holders = sourceFiles().filter((rel) => read(rel).includes("newLayoutDesigns"))
    expect(
      holders,
      "The legacy-shell flag is deleted. A new one-boolean fork between two component trees is " +
        "ruling 13's forbidden shape — remap tokens instead.",
    ).toEqual([])
  })

  test("no source file imports the deleted legacy shell", () => {
    const holders = sourceFiles().filter((rel) => /["']@\/pages\/layout["']|["']\.\/layout["']/.test(read(rel)))
    expect(holders, "`@/pages/layout` (the 2,429-line legacy shell) is deleted.").toEqual([])
  })
})

describe("the legacy directory URL shape still resolves", () => {
  const routes = read("app.tsx")

  test("the app still produces legacy directory hrefs", () => {
    // If this ever goes empty the routes below may be retired — but only then, and deliberately.
    const producers = sourceFiles().filter(
      (rel) => rel !== "app.tsx" && LEGACY_HREF_PATTERNS.some((pattern) => pattern.test(read(rel))),
    )
    expect(producers.length, "no producer left — see the routes test below before deleting them").toBeGreaterThan(0)
  })

  test("app.tsx registers the redirect routes those hrefs land on", () => {
    for (const declaration of ['path="/:dir"', 'path="/:dir/session/:id?"']) {
      expect(
        routes.includes(declaration),
        `app.tsx must keep <Route ${declaration}>: notifications already in a user's tray and ` +
          "novaclaw:// deep links use that URL shape, and nothing else answers it.",
      ).toBe(true)
    }
  })
})

describe("a level-gated ROUTE explains itself instead of bouncing", () => {
  // `RequiresLevel` HIDES its children below the level, which is right for a section INSIDE a page —
  // progressive disclosure, nothing asked, nothing to answer. A route is the opposite situation: the
  // user typed the address or followed a link somebody shared, so the question was asked out loud.
  // `/terminal` used to answer it with `fallback={<Navigate href="/" />}` — a silent bounce to the
  // home screen with no statement that anything was gated and no way to reach it (measured in the
  // running app, 2026-08-05). terminal.md T4 requires the expertise explainer; AGENTS.md principle 8
  // is the reason: that bounce is the single moment the product could teach what expertise levels
  // are, and it said nothing.
  //
  // Violating this compiles green and renders "fine" — standing decision 1's defect class exactly,
  // which is why the check is here rather than in a review comment.
  const pages = sourceFiles().filter((rel) => rel.startsWith("pages/"))

  test("pages exist that gate on expertise", () => {
    // Negative control: if this list empties the assertion below passes vacuously forever.
    expect(pages.filter((rel) => read(rel).includes("RequiresLevel")).length).toBeGreaterThan(0)
  })

  test("no page falls back to a redirect", () => {
    const bouncing = pages.filter((rel) => {
      const source = read(rel)
      if (!source.includes("RequiresLevel")) return false
      return /fallback=\{\s*<Navigate/.test(source)
    })
    expect(
      bouncing,
      "a level-gated page must render an explainer (see @/components/expertise-gate), never redirect: " +
        "a deep link that silently returns the user home teaches them nothing and hides the unlock.",
    ).toEqual([])
  })
})
