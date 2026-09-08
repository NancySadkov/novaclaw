import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { MANIFEST_ROUTE_IDS, MANIFEST_ROUTE_TARGETS, manifestRoutePath } from "@novaclaw/core/app-route"

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

describe("server-scoped provider ordering", () => {
  test("Highlights initializes inside ServerSDK", () => {
    const app = read("app.tsx")
    const selected = app.slice(app.indexOf("function SelectedServerProviders"), app.indexOf("function DraftRoute"))
    const shared = app.slice(app.indexOf("function SharedProviders"), app.indexOf("type ServerScopedShellProps"))

    expect(selected).toMatch(/<ServerSDKProvider>\s*<HighlightsProvider>/)
    expect(shared).not.toContain("<HighlightsProvider>")
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

describe("persisted launcher routes are a closed build-owned vocabulary", () => {
  const routes = code("app.tsx")

  function routeBackedBuiltins(): Record<string, string> {
    const source = code("apps/builtins.tsx")
    const starts = [...source.matchAll(/^\s*id: "([a-z0-9-]+)",$/gm)]
    return Object.fromEntries(
      starts.flatMap((match, index) => {
        const body = source.slice(match.index, starts[index + 1]?.index ?? source.length)
        const route = /navigate\("(\/[^"]*)"\)/.exec(body)?.[1]
        return route ? [[match[1]!, route]] : []
      }),
    )
  }

  test("the shared ids are exactly the route-backed built-in app registry", () => {
    expect(MANIFEST_ROUTE_TARGETS as Readonly<Record<string, string>>).toEqual(routeBackedBuiltins())
  })

  test("every accepted route id resolves to an explicitly registered page", () => {
    const unresolved = MANIFEST_ROUTE_IDS.flatMap((id) => {
      const route = manifestRoutePath(id)
      return route && routes.includes(`<Route path="${route}"`) ? [] : [`${id} -> ${route ?? "(missing)"}`]
    })
    expect(
      unresolved,
      "A manifest route id is a promise that this build owns the target. Register the page in app.tsx " +
        "or remove the id from the shared manifest route contract.",
    ).toEqual([])
  })

  test("manifest launchers resolve ids instead of navigating persisted paths", () => {
    const source = code("apps/manifest-apps.ts")
    expect(source).toContain("manifestRoutePath(manifest.open.value)")
    expect(source).not.toContain("navigate(manifest.open.value)")
    expect(manifestRoutePath("/files")).toBeUndefined()
    expect(manifestRoutePath("stocks")).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A HOME TILE'S `minLevel` MUST BE MIRRORED ON ITS ROUTE.
//
// `RequiresLevel` HIDES its children below the level, which is right for a section INSIDE a page —
// progressive disclosure, nothing asked, nothing to answer. A route is the opposite situation: the
// user typed the address or followed a link somebody shared, so the question was asked out loud.
// `/terminal` used to answer it with `fallback={<Navigate href="/" />}` — a silent bounce to the home
// screen with no statement that anything was gated and no way to reach it (measured in the running
// app, 2026-08-05). terminal.md T4 requires the expertise explainer; AGENTS.md principle 8 is the
// reason: that bounce is the single moment the product could teach what expertise levels are, and it
// said nothing.
//
// ⚠️ WHY THIS BLOCK WAS REWRITTEN (2026-08-19). The version before it filtered the page list with
//
//     if (!source.includes("RequiresLevel")) return false
//
// i.e. a page with NO gate at all was excluded from the check and passed VACUOUSLY. The test could
// not fail for the exact defect it exists to prevent, and two pages shipped through the hole:
// `/debug` and `/registry` carry `minLevel: "developer"` on their tiles and rendered in full at
// `expertiseLevel: "normal"` when deep-linked (measured in the running web app, 2026-08-19 — the
// Debug app served its error log, instance log and the `ps` table of raw session ids). The tile hid
// the icon; nothing guarded the address.
//
// So the check now runs the other way round: the REQUIREMENT is derived from `apps/builtins.tsx` —
// the same table the home screen filters on — and every gated tile's page is then required to gate.
// A page cannot opt out by omission, because it is never the page that decides it is in scope.
//
// ⚠️ And the list is DERIVED, never hand-written. A hand-listed set of pages is the same defect one
// level up: it passes while the thing it names has moved (this repo has already paid for that once,
// with a boot-node checklist that named three nodes by hand and stayed green over a dead feature).
// The derivation is itself controlled below — parse failures and unresolvable routes FAIL rather
// than shrinking the list silently, which is the only way a derived list is safer than a typed one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A file's source with comments removed.
 *
 * ⚠️ Load-bearing, and it cost a red run to learn: the redirect check below matches
 * `fallback={<Navigate`, and the first draft of this block went red naming `pages/debug.tsx` — whose
 * only `Navigate` is the sentence in its header comment EXPLAINING that it must not redirect. A
 * regex over source counts prose; documenting a rule would have been enough to violate it.
 *
 * `//` is left alone when preceded by `:` so a URL inside a string keeps its tail.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

/** A home tile that declares a minimum expertise level, and the route its `open()` navigates to. */
type GatedTile = { id: string; level: string; route: string | undefined }

/**
 * Every `minLevel`-carrying entry of the built-in app table. Entries are sliced between consecutive
 * `id:` lines so a `minLevel` can never be attributed to a neighbouring tile.
 */
function gatedTiles(): GatedTile[] {
  const source = code("apps/builtins.tsx")
  const starts = [...source.matchAll(/^\s*id: "([a-z0-9-]+)",$/gm)]
  return starts.flatMap((match, index) => {
    const body = source.slice(match.index, starts[index + 1]?.index ?? source.length)
    const level = /^\s*minLevel: "(\w+)",$/m.exec(body)?.[1]
    if (!level) return []
    return [{ id: match[1]!, level, route: /navigate\("(\/[^"]*)"\)/.exec(body)?.[1] }]
  })
}

/**
 * The source file behind a route: `app.tsx` maps `path` → component, and its import or explicit
 * lazy declaration maps that component → a `@/pages/...` module. Returns undefined when either
 * hop fails — which the test treats as a FAILURE, not as "nothing to check". A gated page moved
 * behind an indirection this cannot follow must announce itself here rather than quietly leaving
 * the set.
 */
function pageFileForRoute(route: string): string | undefined {
  const app = code("app.tsx")
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const component = new RegExp(`<Route path="${escaped}" component=\\{(\\w+)\\}`).exec(app)?.[1]
  if (!component) return undefined
  for (const entry of app.matchAll(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+"@\/(pages\/[^"]+)"/gm)) {
    const names = (entry[1] ?? entry[2] ?? "").split(",").map(
      (name) =>
        name
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "",
    )
    if (!names.includes(component)) continue
    for (const candidate of [`${entry[3]}.tsx`, `${entry[3]}.ts`, `${entry[3]}/index.tsx`]) {
      if (fs.existsSync(path.join(SRC, candidate))) return candidate
    }
  }
  const lazyImport = new RegExp(`const\\s+${component}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\("@/(pages/[^" ]+)"\\)`).exec(app)?.[1]
  if (lazyImport) {
    for (const candidate of [`${lazyImport}.tsx`, `${lazyImport}.ts`, `${lazyImport}/index.tsx`]) {
      if (fs.existsSync(path.join(SRC, candidate))) return candidate
    }
  }
  return undefined
}

/** Levels declared by `<RequiresLevel … min="x">` in a page. */
function declaredLevels(source: string): string[] {
  return [...source.matchAll(/<RequiresLevel[^>]*?min="(\w+)"/g)].map((match) => match[1]!)
}

describe("a level-gated ROUTE explains itself instead of bouncing", () => {
  const tiles = gatedTiles()

  test("the derivation still finds the gated tiles", () => {
    // Controls on the parser, so a regex that stops matching cannot empty the requirement set and
    // turn every assertion below green. The second one is an INDEPENDENT count of the same fact:
    // occurrences of the property in the raw file, which does not go through the slicing above.
    expect(tiles.length, "no minLevel tile parsed out of apps/builtins.tsx — the parser broke").toBeGreaterThan(0)
    expect(tiles.length, "sliced tiles disagree with the raw count of `minLevel:` in apps/builtins.tsx").toBe(
      code("apps/builtins.tsx").match(/^\s*minLevel: "\w+",$/gm)?.length ?? 0,
    )
  })

  test("every gated tile resolves to a page file", () => {
    const unresolved = tiles.filter((tile) => !tile.route || !pageFileForRoute(tile.route))
    expect(
      unresolved.map((tile) => `${tile.id} -> ${tile.route ?? "(no navigate)"}`),
      "a gated tile whose page cannot be located is NOT exempt — it is unchecked. Point the tile at a " +
        "route registered in app.tsx with an imported or explicitly lazy page component, or extend this resolver.",
    ).toEqual([])
  })

  test("every page behind a gated tile gates the route itself", () => {
    const ungated = tiles.flatMap((tile) => {
      const file = tile.route ? pageFileForRoute(tile.route) : undefined
      if (!file) return [] // reported by the test above
      const source = code(file)
      const levels = declaredLevels(source)
      if (!levels.includes(tile.level)) return [`${file} (tile ${tile.id}) has no <RequiresLevel min="${tile.level}">`]
      if (!source.includes("ExpertiseGate")) return [`${file} (tile ${tile.id}) gates without an explainer`]
      return []
    })
    expect(
      ungated,
      "a tile's minLevel only hides the ICON. The route is reachable by typed URL, OS notification and " +
        "shared link, so the page must gate itself at the same level and render @/components/expertise-gate.",
    ).toEqual([])
  })

  test("no page falls back to a redirect", () => {
    // Broader than the tile-derived set on purpose: this one asks about EVERY page that gates,
    // including sections gated for reasons no tile records.
    const bouncing = sourceFiles()
      .filter((rel) => rel.startsWith("pages/"))
      .filter((rel) => {
        const source = code(rel)
        return source.includes("RequiresLevel") && /fallback=\{\s*<Navigate/.test(source)
      })
    expect(
      bouncing,
      "a level-gated page must render an explainer (see @/components/expertise-gate), never redirect: " +
        "a deep link that silently returns the user home teaches them nothing and hides the unlock.",
    ).toEqual([])
  })
})
