import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, relative, resolve } from "node:path"

/**
 * **The v1→v2 design-system fork may only SHRINK.**
 *
 * todo.md ruling 13: *"One design system; one palette control in the lay tab. uix.md §2's law
 * verbatim — 'theme by remapping tokens, never by forking components.' The v1→v2 fork stops being a
 * standing contributor choice via a **ratchet test**."*
 *
 * `packages/ui` ships the same widget twice. `src/components/button.tsx` is v1;
 * `src/v2/components/button-v2.tsx` is v2; both are live, and several files import BOTH
 * (`pages/home.tsx` renders a v1 `Button` and a v2 `ButtonV2` on one screen). Reaching for `@novaclaw/ui/button` instead of `@novaclaw/ui/v2/button-v2`
 * is one import line that typechecks, renders, and reviews as consistent with its neighbours. That is
 * the defect class ruling 1 names — *an invariant whose violation compiles green ships with a
 * mechanical check, or the invariant does not exist* — so the choice is made red here instead.
 *
 * **This file does not migrate anything.** It measures the fork and pins the measurement. Every
 * number below is an honest count of today's tree, not a target — and every number that a test does
 * NOT re-derive has been deleted from the prose, because three rounds running those were the wrong
 * ones (see `V1_CALL_SITES`).
 *
 * ## What is pinned, and what is deliberately NOT
 *
 * Three ledgers, each a ratchet that fails in BOTH directions — a new offender fails outright, and a
 * pinned entry that no longer applies fails with *delete the line*, so un-pinning is mandatory rather
 * than optional and no ledger can rot into a rubber stamp.
 *
 *   1. `FORKED_WIDGETS` — the fork's **WIDTH**: widget names that exist on both sides. Adding
 *      `card-v2.tsx` next to a live `card.tsx` re-widens the fork and fails here. This is the pin
 *      ruling 13 is really about, and nothing else in the tree checks it.
 *   2. `V1_CALL_SITES` — the fork's **DEPTH**: every file that imports the v1 side of a forked pair,
 *      pinned BY NAME with the exact widgets it takes. Migrating a file means deleting its line.
 *   3. `V1_COMPONENT_CEILING` — the v1 tree may not grow. A bound, not a name list (see below).
 *
 * **A count-only pin would have been the cheap option and it is the wrong one.** Ruling 13's own
 * wording — *"fails on the 32nd v1 Button import"* — describes an integer, and an integer cannot tell
 * a migration from a regression: migrate one file to v2, add a v1 import somewhere else, and the
 * count is unchanged while the fork stood still. Names cost ~90 lines and buy two things a number
 * cannot: a NEW v1 import fails *saying which file*, and every migration is forced to delete a line,
 * which is the ratchet clicking. `packages/sdk/js/test/legacy-path-ledger.test.ts` (ruling 11) made
 * the same trade for the same reason; this file follows it.
 *
 * ⚠️ **NOT covered, stated so nobody records it as covered:**
 *  - **Which side a file *renders*.** This reads import graphs. A file could import v1 `Button` and
 *    never call it; a file could re-export a v1 widget under a v2-looking name. Both read as v1 here,
 *    which is the safe direction.
 *  - **`packages/ui`'s own internal composition is pinned but not migratable.** `ui/src/components/*`
 *    entries are v1 components importing other v1 components (v1 `Select` uses v1 `Button`).
 *    Rewriting those to v2 would be wrong — v1 `Select` must stay coherent. Those lines are only
 *    deletable when the v1 component itself dies, and that is exactly the accounting we want: they
 *    are fork debt whose retirement is a deletion, not a migration.
 *  - **Runtime string references other than `mock.module`.** A widget reached by a computed
 *    specifier would be missed. There is none today (the only two `import.meta.glob` calls in the
 *    renderer packages target `./themes/*.json` and `assets/audio/*.aac`), and the sweep asserts a
 *    floor so a stripping/pattern bug cannot silently empty it.
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
 * ⚠️ It is also NOT shaped like `packages/app/src/app-routes.test.ts`. That file cites ruling 13
 * verbatim and so looks like the precedent, but it is a binary must-be-absent guard for a deleted
 * flag. v1 `Button` still has live call sites; "this stays deleted" is the wrong shape and would only
 * fail.
 *
 * **Measured 2026-07-31**, in the same change that deleted seven fully dead v1 components
 * (`text-shimmer`, `card`, `context-menu`, `hover-card`, `inline-input`, `progress`, `typewriter` —
 * 1,164 lines, zero importers by every reference form below). `text-shimmer` was the one that shrank
 * the FORK: its `text-shimmer-v2` sibling has a live importer, so v1's copy was fully migrated and
 * the pair is gone. The other six were dead v1 code with no v2 twin.
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
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "")
}

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
 * This list may only ever get SHORTER. Retired so far, newest first: `dialog`, `select` (both
 * 2026-08-08), `toast`, `keybind`, `progress-circle`, `diff-changes`, `switch` (all 2026-08-07),
 * `text-shimmer` (2026-07-31), and the six v1-only components deleted alongside it.
 *
 * ⭐ **The shape the rest of this list should copy — a pair is RETIRABLE when nothing in
 * `packages/ui` composes its v1 side.** Then migrating the leaf call sites leaves the v1 file with
 * zero importers and the pair can be deleted rather than merely thinned, which is the only move that
 * shrinks the fork's WIDTH. `switch` (4 call sites), then `keybind` (2), `progress-circle` (1),
 * `diff-changes` (1) and `toast` (3) went that way. A widget that `packages/ui` composes internally
 * (`button`, `icon`, `icon-button`, `tooltip`) cannot reach zero until its v1 consumers die, which
 * is why those lines sit in the second block below. `dialog` went the same way on 2026-08-08;
 * `tabs` is the one that is still retirable — nothing in `packages/ui` composes it.
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
 */
export const FORKED_WIDGETS: readonly string[] = ["button", "icon", "icon-button", "tabs", "tooltip"]

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
export const V1_CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  "app/src/apps/manifest-apps.ts": ["icon"],
  "app/src/components/composer/features-control.tsx": ["icon"],
  "app/src/components/composer/model-control.tsx": ["button", "icon"],
  "app/src/components/composer/strict-control.tsx": ["button"],
  "app/src/components/debug-bar.tsx": ["tooltip"],
  "app/src/components/dialog-edit-project.tsx": ["button", "icon"],
  "app/src/components/dialog-release-notes.tsx": ["button"],
  "app/src/components/dialog-select-directory-v2.tsx": ["icon"],
  "app/src/components/dialog-select-file.tsx": ["icon"],
  "app/src/components/dialog-select-model.tsx": ["button", "icon-button", "tooltip"],
  "app/src/components/dialog-select-server.tsx": ["button", "icon", "icon-button"],
  "app/src/components/dialog-session-info.tsx": ["button", "icon"],
  "app/src/components/file-tree.test.ts": ["icon", "tooltip"],
  "app/src/components/file-tree.tsx": ["icon"],
  "app/src/components/prompt-input.tsx": ["button", "icon", "icon-button", "tooltip"],
  "app/src/components/prompt-input/context-items.tsx": ["icon-button", "tooltip"],
  "app/src/components/prompt-input/drag-overlay.tsx": ["icon"],
  "app/src/components/prompt-input/image-attachments.tsx": ["icon", "tooltip"],
  "app/src/components/prompt-input/slash-popover.tsx": ["icon"],
  "app/src/components/prompt-project-selector.tsx": ["icon"],
  "app/src/components/prompt-workspace-selector.tsx": ["icon"],
  "app/src/components/server/server-row.tsx": ["tooltip"],
  "app/src/components/session-context-usage.tsx": ["button", "tooltip"],
  "app/src/components/session/session-context-tab.tsx": ["icon"],
  "app/src/components/session/session-header.tsx": ["tooltip"],
  "app/src/components/session/session-new-view.tsx": ["icon"],
  "app/src/components/session/session-sortable-tab.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/components/session/session-sortable-terminal-tab.tsx": ["icon", "icon-button", "tabs"],
  "app/src/components/settings-keybinds.tsx": ["button", "icon", "icon-button"],
  "app/src/components/settings-v2/dialog-expertise.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-model-tier.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-new-model.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-settings-v2.tsx": ["icon"],
  "app/src/components/settings-v2/models.tsx": ["icon"],
  "app/src/components/settings-v2/storage.tsx": ["icon"],
  "app/src/components/status-popover-body.tsx": ["button", "icon", "tabs"],
  "app/src/components/status-popover.tsx": ["button", "icon"],
  "app/src/pages/calendar.tsx": ["icon"],
  "app/src/pages/debug.tsx": ["icon"],
  "app/src/pages/error.tsx": ["button", "icon"],
  "app/src/pages/files.tsx": ["icon"],
  "app/src/pages/home-screen/app-placeholder.tsx": ["icon"],
  "app/src/pages/home-screen/app-tile.tsx": ["icon"],
  "app/src/pages/home-screen/help-tour.tsx": ["icon"],
  "app/src/pages/home-screen/new-agent-bar.tsx": ["icon"],
  "app/src/pages/home-screen/social-panel.tsx": ["icon"],
  "app/src/pages/home.tsx": ["button", "icon"],
  "app/src/pages/memory-graph.tsx": ["icon"],
  "app/src/pages/notes.tsx": ["icon"],
  "app/src/pages/recipes.tsx": ["icon"],
  "app/src/pages/registry.tsx": ["icon"],
  "app/src/pages/session.tsx": ["button", "tabs"],
  "app/src/pages/session/composer/session-permission-dock.tsx": ["button", "icon"],
  "app/src/pages/session/composer/session-question-dock.tsx": ["button", "icon"],
  "app/src/pages/session/composer/session-responder-dock.tsx": ["button"],
  "app/src/pages/session/composer/session-revert-dock.tsx": ["button", "icon-button"],
  "app/src/pages/session/composer/session-todo-dock.tsx": ["icon-button"],
  "app/src/pages/session/file-tabs.tsx": ["icon-button", "tabs"],
  "app/src/pages/session/session-side-panel.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/pages/session/terminal-panel.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/pages/trash.tsx": ["icon"],
  "app/src/utils/toast.tsx": ["icon"],
  "app/src/wsl/dialog-add-server.tsx": ["button"],
  "session-ui/src/components/file-search.tsx": ["icon"],
  "session-ui/src/components/line-comment.tsx": ["button", "icon"],
  "session-ui/src/components/session-review.tsx": ["button", "icon", "icon-button", "tooltip"],
  // `packages/ui`'s own v1 components composing other v1 components. Not migratable — see the
  // header. These lines retire by DELETING the component, which is how `card.tsx` left this list.
  "ui/src/components/button.tsx": ["icon"],
  "ui/src/components/collapsible.tsx": ["icon"],
  "ui/src/components/icon-button.tsx": ["icon"],
  "ui/src/components/image-preview.tsx": ["icon-button"],
  "ui/src/components/list.tsx": ["icon", "icon-button"],
  "ui/src/components/popover.tsx": ["icon-button"],
  "ui/src/components/text-field.tsx": ["icon-button", "tooltip"],
}

/**
 * `ui/src/components/*.tsx` was 45, then 38 (2026-07-31), 36 (`switch.tsx`, 2026-08-07), 33
 * (`keybind.tsx`, `progress-circle.tsx`, `diff-changes.tsx`), 32 after `toast.tsx` (2026-08-07), and
 * is **31** after `dialog.tsx` went (2026-08-08). A bound rather than
 * a name list, because ruling 13 pins the FORK and a v1-only widget forks nothing — see the header.
 * It may fall freely; raising it means adding a v1 component under a ruling that says new work is
 * v2, so raise it only with a reason written next to it.
 *
 * ⚠️ **A ceiling that is not re-tightened stops ratcheting, and this one had already slipped.** It
 * read 38 while the tree held 37 — one component had been deleted without the pin following, so a
 * new v1 component could have been added for free. Lower it in the same commit as any deletion.
 */
const V1_COMPONENT_CEILING = 30

/** Measured totals, pinned so the ledger stays a measurement rather than an aspiration. */
const V1_CALL_SITE_FILES = 73
const V1_CALL_SITE_PAIRS = 113

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
const SWEPT = sweep(OBSERVED_FORKED)
const OBSERVED_PAIRS = [...SWEPT.v1.values()].reduce((total, widgets) => total + widgets.size, 0)

/** What a reader should DO about a failure, appended to the growth messages. */
const REMEDY = [
  "Import the v2 widget: `@novaclaw/ui/v2/<name>-v2` (todo.md ruling 13 — one design system;",
  "uix.md §2: theme by remapping tokens, never by forking components). The v2 side is free to grow.",
  "Only if the v2 widget genuinely does not exist yet: add the line to V1_CALL_SITES in this file,",
  "raise the measured totals below, and expect to justify growing a set that may only shrink.",
].join("\n  ")

describe("the sweep", () => {
  test("actually has both halves of the fork to look at", () => {
    // Every real assertion below compares against something this sweep produced. If the sweep found
    // nothing — a moved directory, a broken pattern, an over-eager comment strip — each one would
    // become a tautology that passes forever. That is the failure mode this block makes impossible.
    expect(V1_NAMES.length, "no v1 components found — has packages/ui/src/components moved?").toBeGreaterThan(20)
    expect(V2_NAMES.length, "no v2 components found — has packages/ui/src/v2/components moved?").toBeGreaterThan(10)
    expect(SWEPT.files, "the file walk found almost nothing — check SKIP_DIRS").toBeGreaterThan(1_000)
    // ⚠️ **This floor counts BOTH sides, so a retired pair drops it by more than the migration did.**
    // `dialog` (2026-08-08) cost it 10 v1 pairs AND every v2 `dialog-v2` import at once, because a
    // widget that is no longer forked stops being counted on either side; it reads 184 today, having
    // been above 200 before that pair retired — this assertion is what caught the drop. Lower it with
    // each retirement; it is a sanity floor against a broken sweep, never a target, and if it ever
    // has to go near zero the whole ledger should be retired instead (see the last test in this file).
    expect(SWEPT.specifiers, "no forked-widget import found at all — SPECIFIER_PATTERNS is broken").toBeGreaterThan(150)
    expect(SWEPT.v1.size, "the v1 half of the fork reads as empty").toBeGreaterThan(50)
    expect(SWEPT.v2.size, "the v2 half of the fork reads as empty").toBeGreaterThan(20)
  })

  test("does not read its own ledger as source code", () => {
    // This file is inside the swept tree and its ledger is a wall of widget names and specifier
    // literals. Anchored patterns + comment stripping are what stop it reporting itself; if either
    // regressed, this file would appear as its own worst offender.
    expect(
      [...SWEPT.v1.keys()],
      "the ledger is matching its own literals — SPECIFIER_PATTERNS lost its ^ anchor",
    ).not.toContain("app/src/ui-fork-ledger.test.ts")
  })

  test("the ledgers are real lists with no duplicate entries", () => {
    expect(new Set(FORKED_WIDGETS).size, "FORKED_WIDGETS contains a duplicate").toBe(FORKED_WIDGETS.length)
    for (const [file, widgets] of Object.entries(V1_CALL_SITES))
      expect(new Set(widgets).size, `${file} lists a widget twice`).toBe(widgets.length)
  })
})

describe("the fork's WIDTH can only shrink", () => {
  test("no new v1/v2 duplicate pair — and a retired pair leaves the ledger", () => {
    const appeared = OBSERVED_FORKED.filter((widget) => !FORKED_WIDGETS.includes(widget))
    const vanished = FORKED_WIDGETS.filter((widget) => !OBSERVED_FORKED.includes(widget))
    expect(
      appeared,
      [
        "A widget now exists on BOTH sides of the design system — the fork got WIDER:",
        `  ${appeared.join(", ")}`,
        "",
        "  Ruling 13 forbids forking a component to change it. Remap the tokens instead",
        "  (uix.md §2), or delete the side you are replacing.",
      ].join("\n"),
    ).toEqual([])
    expect(
      vanished,
      [
        "A pinned pair is no longer forked — one side is gone. Un-pinning is MANDATORY:",
        `  ${vanished.join(", ")}`,
        "",
        "  DELETE those names from FORKED_WIDGETS and lower the count pin below.",
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

describe("the fork's DEPTH can only shrink", () => {
  test("a new v1 import of a forked widget fails HERE, by name, not in a review", () => {
    const offenders = newV1Usage(SWEPT.v1, V1_CALL_SITES)
    expect(
      offenders,
      [
        "A file imports the v1 side of a widget that already exists in v2, and is not on the ledger:",
        `  ${offenders.join("\n  ") || "(none)"}`,
        "",
        `  ${REMEDY}`,
      ].join("\n"),
    ).toEqual([])
  })

  test("a migrated file must be DELETED from the ledger", () => {
    const stale = staleV1Pins(SWEPT.v1, V1_CALL_SITES)
    expect(
      stale,
      [
        "The ledger pins v1 usage the tree no longer has. Un-pinning is MANDATORY:",
        `  ${stale.join("\n  ")}`,
        "",
        "  Delete those lines (or those widget names) from V1_CALL_SITES and lower the measured",
        "  totals below. A ledger that keeps dead entries stops being a measurement of the real fork.",
        "  If you MOVED a file rather than migrating it, move its line instead.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the ledger is exactly today's measured fork", () => {
    // Pinned as a MEASUREMENT, not a target. Migrating a call site is SUPPOSED to fail here — that
    // failure is the ratchet clicking, and lowering these numbers is how the migration is recorded.
    expect(Object.keys(V1_CALL_SITES).length, "the ledger's own length moved — recount this pin").toBe(
      V1_CALL_SITE_FILES,
    )
    expect(SWEPT.v1.size, "the observed v1 call-site count moved — reconcile V1_CALL_SITES").toBe(V1_CALL_SITE_FILES)
    expect(OBSERVED_PAIRS, "the observed (file, widget) pair count moved — reconcile V1_CALL_SITES").toBe(
      V1_CALL_SITE_PAIRS,
    )
    expect(FORKED_WIDGETS.length, "the forked-pair count moved — reconcile FORKED_WIDGETS").toBe(5)
  })

  test("both sides are genuinely live — this is a fork, not a finished migration", () => {
    // The premise the whole file rests on: both design systems are live and SOME SCREENS MIX THEM —
    // 27 files imported both sides on 2026-07-31, `pages/home.tsx` among them. Deliberately a floor
    // and not an exact pin: migrating a file already fails two assertions above, and a third failure
    // for the same cause is noise. What this guards is the OTHER end — if the v1 half ever reaches
    // zero, ruling 13 is satisfied and this whole ledger should be replaced by a must-be-absent
    // guard in `app-routes.test.ts`'s shape, rather than left behind asserting nothing.
    const mixed = [...SWEPT.v1.keys()].filter((file) => SWEPT.v2.has(file))
    expect(
      mixed.length,
      "no file mixes the two design systems any more — the fork may be finished; retire this ledger",
    ).toBeGreaterThan(0)
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

describe("the seven deleted v1 components stay deleted", () => {
  // The other half of this change: 1,164 lines with zero importers by every reference form the
  // sweep understands. Re-adding one is re-adding cruft todo.md's *we discard all the cruft* ruling
  // deleted, and `text-shimmer` in particular would re-widen the fork.
  const DELETED = ["text-shimmer", "card", "context-menu", "hover-card", "inline-input", "progress", "typewriter"]

  test("neither the component nor its stylesheet is back", () => {
    const present = readdirSync(V1_DIR)
    for (const name of DELETED) {
      expect(present, `${name}.tsx is back — it had zero importers on 2026-07-31`).not.toContain(`${name}.tsx`)
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
    // invisible before.** FOUR v2 sheets target a `[data-component]` a v1 sheet also targets (six on
    // 2026-08-06, five that afternoon): `badge-v2` → `tag`, `tabs-v2` → `icon-button`,
    // `toast-v2` → `icon`. `switch-v2`/`switch.css`, then `diff-changes-v2`/`diff-changes.css`, then
    // `dialog-v2`/`dialog.css` left the list when the v1 sheet was DELETED — the only way a
    // collision goes away for good.
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
