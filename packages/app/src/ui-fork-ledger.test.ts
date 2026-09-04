import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, relative, resolve } from "node:path"
import { stripComments } from "@/utils/strip-comments"

/**
 * **The retired v1→v2 design-system fork must stay absent.**
 *
 * todo.md ruling 13: *"One design system; one palette control in the lay tab. uix.md §2's law
 * verbatim — 'theme by remapping tokens, never by forking components.' The v1→v2 fork stops being a
 * standing contributor choice via a **ratchet test**."*
 *
 * The last duplicated component, `icon`, was retired 2026-08-09. The active debt ledger that used to
 * live here correctly failed when its v1 call-site count reached zero; leaving an empty ledger would
 * make its sweep assertions tautologies. The permanent invariant is simpler and stronger: the v1 and
 * v2 component-name sets must never intersect again. Adding `card-v2.tsx` beside a live `card.tsx`, or
 * restoring any explicitly retired v1 component, fails here.
 *
 * `V1_COMPONENT_CEILING` remains a separate ratchet. A v1-only component is not a fork, but new design-
 * system work still belongs in v2, so the old tree may shrink freely and may not grow accidentally.
 *
 * ⚠️ **NOT covered, stated so nobody records it as covered:**
 *  - **A brand-new v1-only component is bounded, not named.** Ruling 13 pins the *fork*; a v1
 *    component with no v2 twin is the design system's only implementation of that widget, not a fork
 *    of anything, so a name ledger would forbid work no ruling forbids. `V1_COMPONENT_CEILING` still
 *    makes growth a deliberate edit with a justification attached.
 *
 * ## Why this file lives in `packages/app/src`
 *
 * The fork spans three packages — the duplicated files are in `ui` and the great majority of the call
 * sites are in `app` — so the ledger has to see all of them at once, exactly like
 * `packages/app/src/renderer-dependency-ledger.test.ts`, which sweeps `app`/`ui`/`session-ui` from
 * this same directory. It is NOT in `packages/ui/test/`: `script/test.ts` runs the `ui` unit as
 * `bun test src`, so a file under `packages/ui/test/` would never execute — a guard nobody runs is
 * the zombie code todo.md's *we discard all the cruft* ruling names.
 *
 * This file also owns the component stylesheet layer/order guards because those span app, ui and
 * session-ui in the same way the former fork did.
 */

/** `packages/app/src` → `packages/`. Every path in every ledger is relative to this. */
const PACKAGES = resolve(import.meta.dir, "..", "..")

const V1_DIR = join(PACKAGES, "ui", "src", "components")
const V2_DIR = join(PACKAGES, "ui", "src", "v2", "components")

/** Build outputs and vendored trees. `out/` in particular holds a full copy of the renderer bundle. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  ".ts-dist",
  ".turbo",
  ".git",
  "playwright-report",
  "test-results",
  "build",
])

/**
 * ⚠️ Comments are stripped before ANY matching, using pitfall #6's negative-lookbehind idiom so a
 * `https://` inside a string can never be read as the start of a line comment. Two sibling ledgers
 * false-positived last round on source text that was never code — one on a comment that mentioned
 * the thing it hunted, one on a test title — and this file's own ledger is full of widget names, so
 * a sweep that reads prose would report itself.
 */

/**
 * Anchored on purpose — the second half of the self-detection defence. An unanchored specifier match
 * would read the ledger literals in THIS file, and `V1_CALL_SITES` would grow a line for itself
 * every time it is edited. Only a real declaration reaches these: static `import`/`export … from`,
 * a side-effect import, a dynamic import call, a CommonJS require call, and `mock.module`.
 *
 * ⚠️ **Do not write those last two call shapes literally in this comment.** The neighbouring
 * `renderer-dependency-ledger.test.ts` matches dynamic-import and require calls WITHOUT a line
 * anchor, so a doc comment spelling one out with a quoted argument registers as a real undeclared
 * dependency of `packages/app` and turns that file red. It did, once, while this one was being
 * written — the same comment-eaten-as-code false positive two sibling ledgers hit last round, and
 * proof that prose in a swept tree is not inert.
 *
 * `mock.module` is included because a test stubbing a v1 component is real coupling to the v1 side:
 * when its subject migrates, the stub must move too, and leaving it behind is cruft the migration
 * should have swept. It has now caught exactly that once — `prompt-input/submit.test.ts` stubbed
 * `@novaclaw/ui/toast`, a module its subject never imported directly, and the `toast` migration had
 * to move the stub onto `@/utils/toast` for the unit to keep testing anything.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^[ \t]*(?:import|export)\s+(?:type\s+)?[^'"`;]*?from\s*["'`]([^"'`]+)["'`]/gm,
  /^[ \t]*import\s*["'`]([^"'`]+)["'`]/gm,
  /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bmock\.module\(\s*["'`]([^"'`]+)["'`]/g,
]

/**
 * **The forked widget names. The LIST is the count — do not write the number in this prose.**
 *
 * ⚠️ That is a rule now, not a style note. Every prose index in this file has been wrong at least
 * once, three rounds running, always in the same way: the pins were re-derived and the sentence above
 * them was not. A number a reader can check against the array two lines below is a number that will
 * eventually disagree with it, and the disagreeing copy is the one people quote.
 *
 * A name is on this list when `ui/src/components/<name>.tsx` and its v2 twin both exist. The twin is
 * `v2/components/<name>-v2.tsx`, except `icon`, which is duplicated under the identical filename —
 * two independent registries (v1 carries ~150 glyphs keyed by name, v2 carries ~20 as
 * `{viewBox, body}` pairs), which is why `icon` is the expensive half of the migration rather than a
 * rename.
 *
 * This list may only ever get SHORTER. Retired so far, newest first: `icon-button`, `tooltip`, `tabs`, `dialog`, `select`
 * (all 2026-08-08), `toast`, `keybind`, `progress-circle`, `diff-changes`, `switch` (all
 * 2026-08-07), `text-shimmer` (2026-07-31), and the six v1-only components deleted alongside it.
 *
 * ⭐ **The shape the rest of this list should copy — a pair is RETIRABLE when nothing in
 * `packages/ui` composes its v1 side.** Then migrating the leaf call sites leaves the v1 file with
 * zero importers and the pair can be deleted rather than merely thinned, which is the only move that
 * shrinks the fork's WIDTH. `switch` (4 call sites), then `keybind` (2), `progress-circle` (1),
 * `diff-changes` (1), `toast` (3), `dialog` (9) and `tabs` (7) went that way.
 *
 * ⭐ **`button` proved the next shape, 2026-08-09.** It composed v1 `icon`, but no v1 component
 * composed `button` itself, so migrating its 22 external importer files let the component and sheet
 * disappear and paid one extra `icon` pair as a composition dividend. The three names left really
 * are composed by other v1 components — see the second block of `V1_CALL_SITES`: v1 `collapsible`
 * and `icon-button` import v1 `icon`; `image-preview`, `list`, `popover` and `text-field` import v1
 * `icon-button`. `text-field` used to import both v1 `icon-button` and v1 `tooltip`, but neither
 * dependency was part of its public contract: moving its copy affordance to the v2 primitives retired
 * `tooltip` without rewriting the wrapper's six consumers. The same parent-boundary move then retired
 * `icon-button`: `image-preview`, `list` and `popover` moved their private affordances to v2, leaving
 * no v1 importers. Only `icon` remains, composed internally by `collapsible` and `list` as well as by
 * its external consumers.
 *
 * ⭐ **`select` was retired 2026-08-08, and the budget warning that stood here was RIGHT: it was a
 * contract decision, not an import swap.** The warning read that v1's four call sites pass `size`,
 * `variant`, `triggerStyle` and `triggerProps` — all of which reach v1's trigger only because v1
 * renders it `as={Button}` — while `SelectV2` forwards unknown props to the Kobalte ROOT. Verified
 * true, and worse than stated in two ways the import graph could not show:
 *
 *   - **One of the four call sites was DEAD.** `composer/legacy-model-controls.tsx` was imported by
 *     `prompt-input.tsx` and rendered by nothing; the "legacy layout" its own doc comment said it
 *     dies with was already gone. Deleted, taking four pairs with it.
 *   - **The root/trigger split was already mis-serving the v2 side.** Eight live `SelectV2` call
 *     sites in `settings-v2` passed `data-action="…"`, and one passed `aria-label`, all of which
 *     were landing on Kobalte's `role="group"` wrapper. The `data-action`s looked fine because the
 *     wrapper contains only the trigger; the `aria-label` left the combobox with no accessible name.
 *
 * The ruling: **the trigger is the component's element** — `class` already went there, so `style`,
 * `data-*`, `aria-*` and DOM handlers go there too, and the Kobalte-root props are named
 * exhaustively instead of being whatever is left over. No `triggerProps`/`triggerStyle` shim came
 * back (ruling 13); sizing is `appearance`, and all three surviving call sites state `inline`.
 *
 * ⭐ **`dialog` was retired 2026-08-08. It paid the composition dividend AND had a dead call site —
 * and the defect it turned up was on the V2 side, in the widget every other migration lands on.**
 * Nine v1 call sites, of which `dialog-select-directory.tsx` had had ZERO importers since its `-v2`
 * twin took over (`directory-picker.tsx` and `dialog-select-file.tsx` both reach for
 * `DialogSelectDirectoryV2`). Deleting `ui/src/components/dialog.tsx` also took its own
 * `icon-button` pair, so ten pairs and four files left for a nine-call-site widget.
 *
 * The three couplings the import graph could not show:
 *
 *   - **`[data-component="dialog-overlay"]` was declared by BOTH sheets, identical selector,
 *     identical layer.** The overlay is rendered ONCE — `ui/src/context/dialog.tsx` — and shared by
 *     both forks, so the later `@import` (v2) had been painting the overlay of every v1 dialog.
 *     **Measured in the browser 2026-08-08, with both controls.** Rebuilding the pre-deletion
 *     cascade in a live page — one `@layer components` block holding v1's rule then v2's, exactly
 *     the barrel's order — computes `rgba(10, 6, 24, 0.6)`, byte-identical to v2's rule ALONE, while
 *     v1's rule alone computes `color(srgb 0.0706 0.0706 0.0706 / 0.2)`. Those are not near-misses:
 *     v1 asked for a 20% wash of `--background-base` and the user saw a 60% near-black scrim on
 *     every v1 dialog for as long as both sheets existed. After the deletion the real overlay behind
 *     the command palette computes `rgba(10, 6, 24, 0.6)` — the same value, so removing v1's sheet
 *     is a measured no-op here rather than an argued one. (The element carries no animation and an
 *     inline `!important` overrode it, so neither the transition trap nor a non-cascade cause is in
 *     play.)
 *     Deleting v1's sheet was therefore a measured no-op on the overlay — the same computed value
 *     after. **This is the `diff-changes` shape again: the render looked right because one sheet was
 *     silently winning.**
 *   - **v2's `DialogHeader` hardcoded the English string `"Close"`** as the close button's accessible
 *     name, while the v1 `Dialog` it replaces had localized the same button via `ui.common.close`
 *     since it was written. It was already live on `dialog-select-directory-v2.tsx` — the
 *     project/file picker — and the migration would have carried eight more dialogs into it. Fixed
 *     at the component: `closeLabel` now defaults to the localized key.
 *   - **v1's `action` prop REPLACED the close button** (`<Switch>`: action, else `CloseButton`), so
 *     `dialog-select-model.tsx` shipped with no close affordance. v2's header is a row of children
 *     followed by the close button, so they now coexist. `data-no-header` and `transition` had no
 *     port: the first was styled by nothing at all, and the second was a `prefers-reduced-motion`-less
 *     animation on one call site out of nine (visual.md §6 law 3 makes that guard mandatory).
 *
 * ⭐ **`tabs` was retired 2026-08-08 — and its coupling was a PORTAL, which no cascade check finds.**
 * Seven v1 call sites, one of which (`pages/session.tsx`) imported `Tabs` and never rendered it: a
 * dead import that typechecked, cost a ledger pair, and was invisible to every reference form this
 * sweep understands, because the sweep reads imports and not usage (the header says so — this is
 * that limitation showing up as a real line).
 *
 * Two elements in `ui/src/components/tabs.css` were never the Tabs component's own markup, and both
 * moved to `app/src/pages/session/file-tabs.css` rather than dying with the sheet:
 *
 *   - **`[data-component="tabs-drag-preview"]`** — a plain `<div>` authored in
 *     `pages/session/session-side-panel.tsx` and rendered by solid-dnd's `DragOverlay`, which is
 *     `<Portal mount={document.body}>`. It is therefore NOT a descendant of `[data-component="tabs"]`,
 *     so every `var(--tabs-bar-height, 48px)` in those rules had always resolved to its fallback.
 *     The ported rules inline the literals; the preview renders identically.
 *   - 🔴 **The `.tab-fileicon-color` / `.tab-fileicon-mono` swap, and this one was a live defect.**
 *     `FileVisual` renders BOTH icons absolutely stacked and lets CSS choose; the choosing rules were
 *     scoped to `#review-panel … [data-slot="tabs-trigger"]`, which a body portal can never match.
 *     So inside the drag preview both icons painted and the winner was DOM order — the mono icon, on
 *     top of the colour one the design asks for while a tab is picked up. **The same shape as
 *     `diff-changes`: it looked right because something was silently on top.** The base state now
 *     lives on the markup's own classes, so a two-layer stack cannot render as two layers again.
 *
 * Nothing was shimmed (ruling 13). `hideCloseButton` rendered `data-hidden`, which **nothing in the
 * tree styles**; `classes={{ button }}`'s two call sites asked for `outline: none`,
 * `box-shadow: none` and `width: 100%`, all of which v2's own trigger rules already declare; and
 * `status-popover-body.tsx` passed `data-component="tabs"`, `data-slot="tablist"`,
 * `data-slot="tab"` and `data-active`, every one of them dead — v1's own attributes came after
 * `{...rest}` in the JSX and always won, and no selector matched them anyway. `variant="alt"` is not
 * ported either: `pages/terminal.tsx` had already dropped it when the same terminal tab strip
 * migrated, on the grounds that porting a v1 sheet settles a brand question by copying the v1 app
 * (AGENTS.md — the running app is not a visual reference).
 */
/**
 * **Every file that imports the v1 side of a forked widget, pinned by name.**
 *
 * ⛔ **There is deliberately no count and no per-widget breakdown in this comment.** There used to be
 * both, and they were wrong three rounds in a row — `83 files / 140 pairs` against pins of 83/137
 * and `icon 57` against a measured 56; before that `88 / 162` against pins of `87 / 159`, an
 * `avatar` row for a retired pair, and `icon-button 22` for a measured 21. Every time, the pins were
 * the measurement and the prose was decoration that read like one. The fix is not "re-derive more
 * carefully" — it is to **let the list be the count**: `V1_CALL_SITE_FILES` and
 * `V1_CALL_SITE_PAIRS` below are asserted against the tree on every run, so they cannot drift, and
 * anything a reader wants to know is one `Object.keys(…).length` away. Do not restore the summary.
 *
 * ⚠️ **`toast` moved BOTH counts and by more than its own call sites** (2026-08-07): three v1 toast
 * pairs went, and deleting `ui/src/components/toast.tsx` took its own `icon` + `icon-button` pairs
 * with it — 5 pairs and 2 files for a 3-call-site widget. **Retiring a pair whose v1 file composes
 * other v1 widgets pays a dividend the call-site count does not show.**
 *
 * ⚠️ **Four lines left in one commit and NONE of them was a migration — the files were DELETED**
 * (2026-08-07): `dialog-settings.tsx` and the three panels only it imported (`settings-general`,
 * `settings-models`, `settings-server-picker`; `settings-servers` was already v1-free). The v1
 * Settings dialog had had **zero importers since 2026-06-26** — every `DialogSettings` call site
 * dynamic-`import()`s `./settings-v2` — so 11 of these pairs were fork debt on a surface no user
 * could open. **A pair leaving the ledger is not automatically progress on the migration**; here it
 * is progress on the *tree*, and the distinction matters because the remaining pairs are all live.
 *
 * ⚠️ The file count did NOT move when `keybind`/`progress-circle`/`diff-changes` were migrated: all
 * four of their call sites also import some other v1 widget, so every line survived with one name
 * fewer. **Pairs and files move independently** — a migration that leaves the file count still is
 * doing exactly as much work as one that lowers it.
 *
 * **Migrating a file means deleting its line here.** Adding a widget to a file that is already
 * listed is also new debt, so the widget arrays are compared exactly, not just the file names.
 *
 * ⚠️ **If you RENAME or MOVE a file that is on this list, move its line.** The ledger keys on path,
 * so a move surfaces as one unpinned entry plus one stale pin. That is noisy but correct: it is the
 * only way a path-keyed ratchet can tell a move from a migration, and it costs one line.
 */
/**
 * A CEILING on `ui/src/components/*.tsx`, not a name list — ruling 13 pins the FORK, and a v1-only
 * widget forks nothing (see the header). It may fall freely; RAISING it means adding a v1 component
 * under a ruling that says new work is v2, so raise it only with a reason written beside it.
 *
 * ⚠️ **Lower it in the same commit as any deletion.** A ceiling that is not re-tightened stops
 * ratcheting: this one has already sat above the tree once, and every component of slack is a free
 * slot for the next v1 widget. Do not narrate the history of the number here — that is what made
 * this comment claim 31 while the constant said 24; `git log -S V1_COMPONENT_CEILING` has it.
 */
const V1_COMPONENT_CEILING = 24

// ---------------------------------------------------------------------------------------------
// The sweep. Pure functions first so the negative controls can drive them without touching disk.
// ---------------------------------------------------------------------------------------------

/** `foo-v2` → `foo`; anything else unchanged (`icon` is duplicated under its own name). */
export const v1NameOf = (v2File: string): string => (v2File.endsWith("-v2") ? v2File.slice(0, -3) : v2File)

function componentNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.slice(0, -4))
    .sort()
}

/** Widget names that exist on BOTH sides — the fork, derived from the filesystem. */
export function forkedWidgets(v1: readonly string[], v2: readonly string[]): string[] {
  return [...new Set(v2.map(v1NameOf).filter((name) => v1.includes(name)))].sort()
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (/\.[mc]?[jt]sx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

type Side = "v1" | "v2"

/** Resolve one import specifier to the forked widget it reaches, or `undefined`. */
export function classify(
  fromFile: string,
  rawSpecifier: string,
  forked: readonly string[],
): { widget: string; side: Side } | undefined {
  const specifier = rawSpecifier.replace(/\?.*$/, "")
  let widget: string | undefined
  let side: Side = "v1"
  if (specifier.startsWith("@novaclaw/ui/")) {
    // The package `exports` map is a WILDCARD — `"./*": "./src/components/*.tsx"` and
    // `"./v2/*": "./src/v2/components/*.tsx"` — so there is no barrel to read; the specifier IS the
    // filename. A nested subpath (`context/*`, `i18n/*`, `theme/*`) is not a component.
    const rest = specifier.slice("@novaclaw/ui/".length)
    if (rest.startsWith("v2/")) {
      const name = rest.slice(3)
      if (!name.includes("/")) {
        widget = v1NameOf(name.replace(/\.css$/, ""))
        side = "v2"
      }
    } else if (!rest.includes("/")) {
      widget = rest.replace(/\.(tsx|ts|css)$/, "")
      side = "v1"
    }
  } else if (specifier.startsWith(".")) {
    // Relative imports inside `packages/ui` reach the same files without the specifier ever saying
    // `@novaclaw/ui` — v1 `Select` imports `./button`. A package-name-only sweep would miss all of
    // `packages/ui`, i.e. the half of the fork that defines it.
    const target = relative(PACKAGES, normalize(resolve(dirname(fromFile), specifier)))
      .split("\\")
      .join("/")
    for (const [prefix, resolved] of [
      ["ui/src/components/", "v1"],
      ["ui/src/v2/components/", "v2"],
    ] as const) {
      if (!target.startsWith(prefix)) continue
      const name = target.slice(prefix.length).replace(/\.(tsx|ts|css)$/, "")
      if (name.includes("/")) break
      widget = resolved === "v2" ? v1NameOf(name) : name
      side = resolved
      break
    }
  }
  if (!widget || !forked.includes(widget)) return undefined
  return { widget, side }
}

/** Every forked-widget import in the renderer packages, keyed by file. */
function sweep(forked: readonly string[]): {
  v1: Map<string, Set<string>>
  v2: Map<string, Set<string>>
  files: number
  specifiers: number
} {
  const v1 = new Map<string, Set<string>>()
  const v2 = new Map<string, Set<string>>()
  let specifiers = 0
  const files = sourceFiles(PACKAGES)
  for (const file of files) {
    const rel = relative(PACKAGES, file).split("\\").join("/")
    const code = stripComments(readFileSync(file, "utf8"))
    const seen = new Set<string>()
    for (const pattern of SPECIFIER_PATTERNS)
      for (const match of code.matchAll(pattern)) if (match[1]) seen.add(match[1])
    for (const specifier of seen) {
      const hit = classify(file, specifier, forked)
      if (!hit) continue
      specifiers++
      // A component is not a call site of itself — on either side. Kept symmetric so a v2 component
      // that reaches for a v1 widget still registers on the v1 half (there is none today, and this
      // is what would surface the first one).
      if (hit.side === "v1" && rel === `ui/src/components/${hit.widget}.tsx`) continue
      if (hit.side === "v2" && new RegExp(`^ui/src/v2/components/${hit.widget}(-v2)?\\.tsx$`).test(rel)) continue
      const bucket = hit.side === "v1" ? v1 : v2
      if (!bucket.has(rel)) bucket.set(rel, new Set())
      bucket.get(rel)!.add(hit.widget)
    }
  }
  return { v1, v2, files: files.length, specifiers }
}

/** GROWTH: `file → widgets` observed that the ledger does not excuse. One line per file. */
export function newV1Usage(
  observed: ReadonlyMap<string, ReadonlySet<string>>,
  ledger: Readonly<Record<string, readonly string[]>>,
): string[] {
  const offenders: string[] = []
  for (const [file, widgets] of observed) {
    const pinned = ledger[file]
    if (!pinned) {
      offenders.push(`${file} → ${[...widgets].sort().join(", ")} (file is not on the ledger at all)`)
      continue
    }
    const added = [...widgets].filter((widget) => !pinned.includes(widget)).sort()
    if (added.length > 0) offenders.push(`${file} → ${added.join(", ")} (new widget on an already-pinned file)`)
  }
  return offenders.sort()
}

/** SHRINK debt: ledger entries the tree no longer justifies, one line each with its reason. */
export function staleV1Pins(
  observed: ReadonlyMap<string, ReadonlySet<string>>,
  ledger: Readonly<Record<string, readonly string[]>>,
): string[] {
  const stale: string[] = []
  for (const [file, pinned] of Object.entries(ledger)) {
    const widgets = observed.get(file)
    if (!widgets) {
      stale.push(`${file} (no longer imports any v1 widget — DELETE the whole line)`)
      continue
    }
    const gone = pinned.filter((widget) => !widgets.has(widget)).sort()
    if (gone.length > 0) stale.push(`${file} → ${gone.join(", ")} (migrated — DELETE from this line)`)
    const duplicated = pinned.filter((widget, index) => pinned.indexOf(widget) !== index)
    if (duplicated.length > 0) stale.push(`${file} → ${duplicated.join(", ")} (listed twice — delete the duplicate)`)
  }
  return stale.sort()
}

const V1_NAMES = componentNames(V1_DIR)
const V2_NAMES = componentNames(V2_DIR)
const OBSERVED_FORKED = forkedWidgets(V1_NAMES, V2_NAMES)
describe("the retired design-system fork stays absent", () => {
  test("no component name exists in both v1 and v2", () => {
    expect(V1_NAMES.length, "no v1 components found — has packages/ui/src/components moved?").toBeGreaterThan(20)
    expect(V2_NAMES.length, "no v2 components found — has packages/ui/src/v2/components moved?").toBeGreaterThan(10)
    expect(
      OBSERVED_FORKED,
      [
        "A widget exists on BOTH sides of the design system — the retired fork came back:",
        `  ${OBSERVED_FORKED.join(", ")}`,
        "",
        "Ruling 13 forbids forking a component to change it. Remap tokens or delete the replaced side.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the v1 component tree does not grow", () => {
    expect(
      V1_NAMES.length,
      [
        `packages/ui/src/components now holds ${V1_NAMES.length} components, up from ${V1_COMPONENT_CEILING}.`,
        "New widgets belong in packages/ui/src/v2/components (ruling 13). If this really is a v1-only",
        "component that cannot live there, raise V1_COMPONENT_CEILING and write the reason beside it.",
      ].join("\n"),
    ).toBeLessThanOrEqual(V1_COMPONENT_CEILING)
  })
})

describe("the guard actually bites (negative control)", () => {
  test("comment stripping removes comments and keeps URLs intact", () => {
    // Pitfall #6: a naive `//` strip eats the rest of any line holding `https://`.
    expect(stripComments(`const url = "https://novaclaw.app/v2/button-v2"\n`)).toContain("novaclaw.app/v2/button-v2")
    expect(stripComments(`import { Button } from "@novaclaw/ui/button" // legacy\n`)).toBe(
      `import { Button } from "@novaclaw/ui/button" \n`,
    )
    expect(stripComments(`/* import { Button } from "@novaclaw/ui/button" */\nconst a = 1`)).toBe("\nconst a = 1")
  })

  test("a commented-out v1 import is NOT a call site", () => {
    // The exact false positive two sibling ledgers shipped last round.
    const commented = stripComments(`// import { Button } from "@novaclaw/ui/button"\nexport const a = 1`)
    const found = [...commented.matchAll(SPECIFIER_PATTERNS[0]!)].map((match) => match[1])
    expect(found).toEqual([])
  })

  test("a specifier inside a string literal is NOT a call site — this file's own ledger proves it", () => {
    // Unanchored matching is what would make this file report itself. `V1_CALL_SITES` is exactly
    // this shape: a bare quoted string on its own line.
    const ledgerShaped = `  "app/src/pages/home.tsx": ["button", "dialog", "icon"],\n`
    for (const pattern of SPECIFIER_PATTERNS)
      expect([...ledgerShaped.matchAll(pattern)].map((match) => match[1])).toEqual([])
  })

  test("classify resolves every import form to the right side of the fork", () => {
    const from = join(PACKAGES, "app", "src", "pages", "home.tsx")
    const forked = ["button", "icon", "toast"]
    expect(classify(from, "@novaclaw/ui/button", forked)).toEqual({ widget: "button", side: "v1" })
    expect(classify(from, "@novaclaw/ui/v2/button-v2", forked)).toEqual({ widget: "button", side: "v2" })
    expect(classify(from, "@novaclaw/ui/v2/button-v2.css", forked)).toEqual({ widget: "button", side: "v2" })
    expect(classify(from, "@novaclaw/ui/v2/icon", forked)).toEqual({ widget: "icon", side: "v2" })
    // `icon` is duplicated under the identical filename — the v2 path is the ONLY thing telling them
    // apart, so a bug that dropped the `v2/` prefix would silently score 61 v2 imports as v1.
    expect(classify(from, "@novaclaw/ui/icon", forked)).toEqual({ widget: "icon", side: "v1" })
    // Query suffixes, nested subpaths, and non-forked widgets.
    expect(classify(from, "@novaclaw/ui/button?raw", forked)).toEqual({ widget: "button", side: "v1" })
    expect(classify(from, "@novaclaw/ui/context/dialog", forked)).toBeUndefined()
    expect(classify(from, "@novaclaw/ui/theme/color", forked)).toBeUndefined()
    expect(classify(from, "@novaclaw/ui/spinner", forked)).toBeUndefined()
    expect(classify(from, "solid-js", forked)).toBeUndefined()
    // Relative imports inside packages/ui reach the same files without naming the package.
    const inUi = join(PACKAGES, "ui", "src", "components", "list.tsx")
    expect(classify(inUi, "./button", forked)).toEqual({ widget: "button", side: "v1" })
    expect(classify(inUi, "../v2/components/button-v2", forked)).toEqual({ widget: "button", side: "v2" })
    // A sibling in the same directory that is not a forked widget.
    expect(classify(inUi, "./scroll-view", forked)).toBeUndefined()
  })

  test("the growth half reports a v1 import the ledger does not excuse", () => {
    // Every real assertion above is `toEqual([])`, and an empty array cannot show a non-empty one is
    // reachable. Drive the same pure predicates directly.
    const ledger = { "app/src/pages/home.tsx": ["button"] }
    expect(newV1Usage(new Map([["app/src/pages/home.tsx", new Set(["button"])]]), ledger)).toEqual([])
    expect(newV1Usage(new Map([["app/src/pages/new.tsx", new Set(["button"])]]), ledger)).toEqual([
      "app/src/pages/new.tsx → button (file is not on the ledger at all)",
    ])
    // The seam a file-only ledger cannot see: one pinned file, one new widget.
    expect(newV1Usage(new Map([["app/src/pages/home.tsx", new Set(["button", "tooltip"])]]), ledger)).toEqual([
      "app/src/pages/home.tsx → tooltip (new widget on an already-pinned file)",
    ])
    // …and an empty ledger excuses nothing, so the classifier still bites when the fork is gone.
    expect(newV1Usage(new Map([["app/src/pages/home.tsx", new Set(["button"])]]), {})).toEqual([
      "app/src/pages/home.tsx → button (file is not on the ledger at all)",
    ])
  })

  test("the shrink half reports a pin the tree no longer justifies", () => {
    const observed = new Map([["app/src/pages/home.tsx", new Set(["button"])]])
    expect(staleV1Pins(observed, { "app/src/pages/home.tsx": ["button"] })).toEqual([])
    expect(staleV1Pins(observed, { "app/src/pages/home.tsx": ["button"], "app/src/pages/gone.tsx": ["icon"] })).toEqual(
      ["app/src/pages/gone.tsx (no longer imports any v1 widget — DELETE the whole line)"],
    )
    expect(staleV1Pins(observed, { "app/src/pages/home.tsx": ["button", "tooltip"] })).toEqual([
      "app/src/pages/home.tsx → tooltip (migrated — DELETE from this line)",
    ])
    expect(staleV1Pins(observed, { "app/src/pages/home.tsx": ["button", "button"] })).toEqual([
      "app/src/pages/home.tsx → button (listed twice — delete the duplicate)",
    ])
  })

  test("forkedWidgets sees a re-widened fork and a retired one", () => {
    // The width half, driven directly: `card.tsx` was deleted in this change, so re-adding it
    // beside a hypothetical `card-v2.tsx` must read as a NEW pair.
    expect(forkedWidgets(["button", "spinner"], ["button-v2", "badge-v2"])).toEqual(["button"])
    expect(forkedWidgets(["button", "card"], ["button-v2", "card-v2"])).toEqual(["button", "card"])
    // A v2-only widget forks nothing.
    expect(forkedWidgets(["button"], ["badge-v2", "divider-v2"])).toEqual([])
    // …and deleting the v1 side retires the pair.
    expect(forkedWidgets(["button"], ["button-v2", "text-shimmer-v2"])).toEqual(["button"])
    // `icon` is the one duplicated under an identical filename.
    expect(forkedWidgets(["icon"], ["icon"])).toEqual(["icon"])
  })
})

describe("retired v1 components stay deleted", () => {
  // The other half of this change: 1,164 lines with zero importers by every reference form the
  // sweep understands. Re-adding one is re-adding cruft todo.md's *we discard all the cruft* ruling
  // deleted, and `text-shimmer` in particular would re-widen the fork.
  const DELETED = [
    "button",
    "icon",
    "icon-button",
    "tooltip",
    "text-shimmer",
    "card",
    "context-menu",
    "hover-card",
    "inline-input",
    "progress",
    "typewriter",
  ]

  test("neither the component nor its stylesheet is back", () => {
    const present = readdirSync(V1_DIR)
    for (const name of DELETED) {
      expect(present, `${name}.tsx is back — this retired v1 component must stay deleted`).not.toContain(`${name}.tsx`)
      expect(present, `${name}.css is back`).not.toContain(`${name}.css`)
    }
  })

  /**
   * 🔴 **The v1 and v2 forks are in DIFFERENT CASCADE LAYERS, and that changes what `class=` does.**
   *
   * `ui/src/styles/index.css` opens `@layer theme, base, components, utilities;` and pulls every **v1**
   * component stylesheet in with `layer(components)`. Every **v2** stylesheet is instead imported from
   * its own `.tsx`, which lands it **unlayered** — and an unlayered rule outranks every layered one:
   *
   *   - a v1 component's CSS sits in `components` and LOSES to a Tailwind utility → `class=` works;
   *   - a v2 component's CSS is unlayered and BEATS every utility → `class=` is inert.
   *
   * Measured 2026-08-06: **155 call sites** across `app/src` and `ui/src` pass `class`/`classList` to a
   * v2 component. Each is a place where an author's override may be silently doing nothing — and each
   * is a place that can change appearance the moment this is fixed, which is why this is a LEDGER and
   * not a fix. It also explains why migrating a v1 component to its v2 twin keeps not being the cheap
   * swap it is filed as: the twins' PROPS match and their cascade position does not.
   *
   * ⚠️ **Shrink-only, pinned BY NAME.** Layering one means deleting its own `.css` import, adding
   * `@import "../v2/components/x.css" layer(components);` to the barrel, then checking that
   * component's call sites — their overrides start working. Remove the name here in the same commit.
   * Adding a name is not allowed: a new v2 component should be layered from birth.
   */
  /**
   * 🔴 **A component stylesheet imported from a `.tsx` is UNLAYERED, and outranks every Tailwind
   * utility applied to that component.**
   *
   * `ui/src/styles/index.css` opens `@layer theme, base, components, utilities;` and pulls the v1
   * component stylesheets in with `layer(components)`. A stylesheet imported from a component file
   * instead lands outside every layer — and unlayered rules beat layered ones — so:
   *
   *   - a LAYERED component's CSS loses to a Tailwind utility → `class="size-full"` works;
   *   - an UNLAYERED one beats every utility → the same class is inert.
   *
   * ⚠️ **Scope widened 2026-08-06 from `ui/src/v2/components` to all three UI packages, because the
   * narrow version was measuring the wrong thing.** Chasing `textarea-v2`'s overrides found that all
   * six pass `class="settings-v2-textarea"` — an app-level class in
   * `app/src/components/settings-v2/settings-v2.css`, which is **itself imported from 23 `.tsx` files
   * and therefore also unlayered**. So today those two rules have equal specificity and BOTH sit
   * outside the layers: which one wins is decided by bundler import order, i.e. by nothing anyone
   * chose. Pinning only the `ui/v2` half would have declared that fixed while it was not.
   *
   * ⚠️ **Shrink-only, pinned BY PATH.** Layering one means deleting its `import "./x.css"` and adding
   * an `@import … layer(components)` line to the barrel its package is reached through — then checking
   * that component's call sites, because their overrides start working. Remove the path here in the
   * same commit. Adding a path is refused: a new stylesheet should be layered from birth.
   */
  const UNLAYERED_STYLESHEETS: string[] = []

  test("🔴 every component stylesheet is either LAYERED or pinned — the list can only shrink", () => {
    const found = new Set<string>()
    for (const pkg of ["app", "ui", "session-ui"]) {
      const root = join(PACKAGES, pkg, "src")
      if (!existsSync(root)) continue
      for (const file of sourceFiles(root)) {
        if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue
        for (const match of readFileSync(file, "utf8").matchAll(/^import\s+["'](\.[^"']+\.css)["']/gm)) {
          const target = resolve(dirname(file), match[1]!)
          found.add(relative(join(PACKAGES, ".."), target).split("\\").join("/"))
        }
      }
    }
    const unlayered = [...found].sort()

    expect(
      unlayered.filter((path) => !UNLAYERED_STYLESHEETS.includes(path)),
      "a stylesheet is imported from a .tsx — import it into a CSS barrel with layer(components) instead",
    ).toEqual([])
    expect(
      UNLAYERED_STYLESHEETS.filter((path) => !unlayered.includes(path)),
      "these are layered now — delete them from UNLAYERED_STYLESHEETS in this commit (shrink-only)",
    ).toEqual([])
  })

  test("🔴 every v2 @import comes AFTER every v1 @import — same layer, so ORDER decides", () => {
    // ⚠️ **This became load-bearing the moment v2 stylesheets joined `layer(components)`, and it was
    // invisible before.** The remaining known collisions are `badge-v2` → `tag` and `toast-v2` →
    // `icon`. `switch-v2`/`switch.css`, `diff-changes-v2`/`diff-changes.css`,
    // `dialog-v2`/`dialog.css`, and now `tabs-v2`/`icon-button.css` left the list when the v1 sheet
    // was DELETED — the only way a collision goes away for good.
    //
    // While v2 was UNLAYERED it beat v1 unconditionally. Now both sit in `components`, equal
    // specificity, so the LATER declaration wins — i.e. the order of these `@import` lines is the only
    // thing keeping v2 in front. Verified in the browser 2026-08-06: `[data-component="tag"]` computes
    // v2's values (gap 4px, height 16px, padding 0 4px, radius 2px), not v1's (no gap, 18px, 0 6px).
    // Inserting a v1 import below the v2 block would silently hand those components back to v1.
    //
    // ⚠️ **Order is not the whole story, and `switch` is the counter-example — measured in the browser
    // 2026-08-07.** Order only settles ties at EQUAL specificity. v1 `switch.css` carried three rules
    // that outranked v2's on specificity and therefore won despite sitting above it:
    // `[data-checked] [data-slot="switch-thumb"] { border: none }`,
    // `[data-disabled] [data-slot="switch-thumb"] { background-color: var(--icon-disabled) }`, and a
    // focus `box-shadow`. All THREE were painting v2 switches in `settings-v2`, which is what a
    // "v1-only" stylesheet is not supposed to be able to do. A shared selector is a live coupling in
    // both directions — deleting the v1 sheet is the fix, moving imports around is not.
    //
    // ⚠️ **`diff-changes` proved the SAME coupling running the OTHER way, measured in the browser
    // 2026-08-07 — and this is the case order does hide.** Both sheets said
    // `[data-component="diff-changes"]` (v2's selector carries no `-v2`), equal specificity, so v2
    // won every property it declared — including on the v1 element. Rendered side by side through
    // the dev server, v1 `DiffChanges` and v2 `DiffChanges` computed IDENTICAL type: 11px/440/0.05px
    // in v2's `--v2-state-fg-success`, none of it v1's own 14px `--text-diff-add-base`. The single
    // property flowing the other way was `font-family: var(--font-family-mono)`, which v2 never
    // declares and therefore inherited from v1 — so the one v2 call site (`basic-tool-v2`) rendered
    // its diff counts in mono while every sibling slot in that row is sans. Deleting v1's sheet
    // settles both: v1's dead type scale goes with the component, and v2 finally renders what v2
    // says. **Two sheets agreeing on a selector is not "harmless duplication" even when the
    // rendered result looks right — it looked right because ONE of them was silently winning.**
    const barrel = readFileSync(join(PACKAGES, "ui", "src", "styles", "index.css"), "utf8")
    const lines = barrel.split("\n")
    const lastV1 = lines.reduce(
      (last, line, index) => (/@import\s+["']\.\.\/components\/[^"']+\.css["']/.test(line) ? index : last),
      -1,
    )
    const firstV2 = lines.findIndex((line) => /@import\s+["']\.\.\/v2\/components\/[^"']+\.css["']/.test(line))
    expect(firstV2, "no v2 stylesheet is imported by the barrel — has the migration moved?").toBeGreaterThan(-1)
    expect(
      lastV1,
      "a v1 @import sits BELOW the v2 block — v2 loses every shared selector to it; move it up",
    ).toBeLessThan(firstV2)
  })

  test("the CSS barrel has no dangling @import — a break no typecheck can see", () => {
    // `packages/ui/src/styles/index.css` is reached from app/src/index.css via
    // `@novaclaw/ui/styles/tailwind` → `../index.css`, and it `@import`s each component stylesheet
    // by name. A deleted `.css` whose line survives is a hard `vite build` failure that every unit
    // test and every typecheck reports as green.
    const barrel = join(PACKAGES, "ui", "src", "styles", "index.css")
    const text = readFileSync(barrel, "utf8")
    const targets = [...text.matchAll(/@import\s+["']([^"']+\.css)["']/g)].map((match) => match[1]!)
    expect(targets.length, "the CSS barrel stopped importing components — has it moved?").toBeGreaterThan(30)
    const dangling = targets
      .filter((target) => target.startsWith("."))
      .filter((target) => !existsSync(resolve(dirname(barrel), target)))
    expect(dangling, "packages/ui/src/styles/index.css imports a stylesheet that does not exist").toEqual([])
  })
})
