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
 * `src/v2/components/button-v2.tsx` is v2; both are live, and 27 files import one side while 57
 * import the other — several files import BOTH (`pages/home.tsx` renders a v1 `Button` and a v2
 * `ButtonV2` on one screen). Reaching for `@novaclaw/ui/button` instead of `@novaclaw/ui/v2/button-v2`
 * is one import line that typechecks, renders, and reviews as consistent with its neighbours. That is
 * the defect class ruling 1 names — *an invariant whose violation compiles green ships with a
 * mechanical check, or the invariant does not exist* — so the choice is made red here instead.
 *
 * **This file does not migrate anything.** It measures the fork and pins the measurement. Every
 * number below is an honest count of today's tree, not a target.
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
 * The fork spans three packages — the duplicated files are in `ui`, and 76 of the 88 call sites are
 * in `app` — so the ledger has to see all of them at once, exactly like
 * `packages/app/src/renderer-dependency-ledger.test.ts`, which sweeps `app`/`ui`/`session-ui` from
 * this same directory. It is NOT in `packages/ui/test/`: `script/test.ts` runs the `ui` unit as
 * `bun test src`, so a file under `packages/ui/test/` would never execute — a guard nobody runs is
 * the zombie code todo.md's *we discard all the cruft* ruling names.
 *
 * ⚠️ It is also NOT shaped like `packages/app/src/app-routes.test.ts`. That file cites ruling 13
 * verbatim and so looks like the precedent, but it is a binary must-be-absent guard for a deleted
 * flag. v1 `Button` has 27 live call sites; "this stays deleted" is the wrong shape and would only
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
 * `mock.module` is included because a test stubbing `@novaclaw/ui/toast` is real coupling to the v1
 * side: when its subject migrates, the stub must move too, and leaving it behind is cruft the
 * migration should have swept.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^[ \t]*(?:import|export)\s+(?:type\s+)?[^'"`;]*?from\s*["'`]([^"'`]+)["'`]/gm,
  /^[ \t]*import\s*["'`]([^"'`]+)["'`]/gm,
  /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bmock\.module\(\s*["'`]([^"'`]+)["'`]/g,
]

/**
 * **The forked widget names, measured 2026-07-31: 13.**
 *
 * A name is on this list when `ui/src/components/<name>.tsx` and its v2 twin both exist. The twin is
 * `v2/components/<name>-v2.tsx`, except `icon`, which is duplicated under the identical filename —
 * two independent registries (v1 carries ~150 glyphs keyed by name, v2 carries ~20 as
 * `{viewBox, body}` pairs), which is why `icon` is 61 call sites and the expensive half of the
 * migration rather than a rename.
 *
 * This list may only ever get SHORTER. It was 14 before this change.
 */
export const FORKED_WIDGETS: readonly string[] = [
  "avatar",
  "button",
  "dialog",
  "diff-changes",
  "icon",
  "icon-button",
  "keybind",
  "progress-circle",
  "select",
  "switch",
  "tabs",
  "toast",
  "tooltip",
]

/**
 * **Every file that imports the v1 side of a forked widget, measured 2026-07-31: 88 files, 162
 * (file, widget) pairs.** Grouped by package: `app` 76, `ui` 9, `session-ui` 3.
 *
 * Per-widget: icon 61 · button 28 · icon-button 22 · tooltip 16 · dialog 10 · tabs 8 · select 5 ·
 * switch 4 · toast 3 · keybind 2 · avatar 1 · diff-changes 1 · progress-circle 1.
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
  "app/src/components/composer/legacy-model-controls.tsx": ["button", "icon", "select", "tooltip"],
  "app/src/components/composer/model-control.tsx": ["button", "icon"],
  "app/src/components/composer/permission-mode-control.tsx": ["select"],
  "app/src/components/composer/strict-control.tsx": ["button"],
  "app/src/components/composer/variant-control.tsx": ["select"],
  "app/src/components/debug-bar.tsx": ["tooltip"],
  "app/src/components/dialog-edit-project.tsx": ["avatar", "button", "dialog", "icon"],
  "app/src/components/dialog-fork.tsx": ["dialog"],
  "app/src/components/dialog-release-notes.tsx": ["button", "dialog"],
  "app/src/components/dialog-select-directory-v2.tsx": ["icon"],
  "app/src/components/dialog-select-directory.tsx": ["dialog"],
  "app/src/components/dialog-select-file.tsx": ["dialog", "icon", "keybind"],
  "app/src/components/dialog-select-mcp.tsx": ["dialog", "switch"],
  "app/src/components/dialog-select-model.tsx": ["button", "dialog", "icon-button", "tooltip"],
  "app/src/components/dialog-select-server.tsx": ["button", "dialog", "icon", "icon-button"],
  "app/src/components/dialog-session-info.tsx": ["button", "icon"],
  "app/src/components/dialog-settings.tsx": ["dialog", "icon", "tabs"],
  "app/src/components/file-tree.test.ts": ["icon", "tooltip"],
  "app/src/components/file-tree.tsx": ["icon"],
  "app/src/components/prompt-input.tsx": ["button", "icon", "icon-button", "tooltip"],
  "app/src/components/prompt-input/context-items.tsx": ["icon-button", "tooltip"],
  "app/src/components/prompt-input/drag-overlay.tsx": ["icon"],
  "app/src/components/prompt-input/image-attachments.tsx": ["icon", "tooltip"],
  "app/src/components/prompt-input/slash-popover.tsx": ["icon"],
  "app/src/components/prompt-input/submit.test.ts": ["toast"],
  "app/src/components/prompt-project-selector.tsx": ["icon"],
  "app/src/components/prompt-workspace-selector.tsx": ["icon"],
  "app/src/components/server/server-row.tsx": ["tooltip"],
  "app/src/components/session-context-usage.tsx": ["button", "progress-circle", "tooltip"],
  "app/src/components/session/session-context-tab.tsx": ["icon"],
  "app/src/components/session/session-header.tsx": ["button", "icon", "icon-button", "keybind", "tooltip"],
  "app/src/components/session/session-new-view.tsx": ["icon"],
  "app/src/components/session/session-sortable-tab.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/components/session/session-sortable-terminal-tab.tsx": ["icon", "icon-button", "tabs"],
  "app/src/components/settings-general.tsx": ["button", "icon", "select", "switch", "tooltip"],
  "app/src/components/settings-keybinds.tsx": ["button", "icon", "icon-button"],
  "app/src/components/settings-models.tsx": ["icon", "icon-button", "switch"],
  "app/src/components/settings-server-picker.tsx": ["button", "icon"],
  "app/src/components/settings-v2/dialog-expertise.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-model-tier.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-new-model.tsx": ["icon"],
  "app/src/components/settings-v2/dialog-settings-v2.tsx": ["icon"],
  "app/src/components/settings-v2/models.tsx": ["icon"],
  "app/src/components/settings-v2/storage.tsx": ["icon"],
  "app/src/components/status-popover-body.tsx": ["button", "icon", "switch", "tabs"],
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
  "app/src/pages/home.tsx": ["button", "dialog", "icon"],
  "app/src/pages/memory-graph.tsx": ["icon"],
  "app/src/pages/notes.tsx": ["icon"],
  "app/src/pages/recipes.tsx": ["icon"],
  "app/src/pages/registry.tsx": ["icon"],
  "app/src/pages/session.tsx": ["button", "select", "tabs"],
  "app/src/pages/session/composer/session-followup-dock.tsx": ["button", "icon-button"],
  "app/src/pages/session/composer/session-permission-dock.tsx": ["button", "icon"],
  "app/src/pages/session/composer/session-question-dock.tsx": ["button", "icon"],
  "app/src/pages/session/composer/session-responder-dock.tsx": ["button"],
  "app/src/pages/session/composer/session-revert-dock.tsx": ["button", "icon-button"],
  "app/src/pages/session/composer/session-todo-dock.tsx": ["icon-button"],
  "app/src/pages/session/file-tabs.tsx": ["icon-button", "tabs"],
  "app/src/pages/session/session-side-panel.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/pages/session/terminal-panel.tsx": ["icon-button", "tabs", "tooltip"],
  "app/src/pages/trash.tsx": ["icon"],
  "app/src/utils/toast.tsx": ["icon", "toast"],
  "app/src/wsl/dialog-add-server.tsx": ["button", "toast"],
  "session-ui/src/components/file-search.tsx": ["icon"],
  "session-ui/src/components/line-comment.tsx": ["button", "icon"],
  "session-ui/src/components/session-review.tsx": ["button", "diff-changes", "icon", "icon-button", "tooltip"],
  // `packages/ui`'s own v1 components composing other v1 components. Not migratable — see the
  // header. These lines retire by DELETING the component, which is how `card.tsx` left this list.
  "ui/src/components/button.tsx": ["icon"],
  "ui/src/components/collapsible.tsx": ["icon"],
  "ui/src/components/dialog.tsx": ["icon-button"],
  "ui/src/components/icon-button.tsx": ["icon"],
  "ui/src/components/image-preview.tsx": ["icon-button"],
  "ui/src/components/list.tsx": ["icon", "icon-button"],
  "ui/src/components/popover.tsx": ["icon-button"],
  "ui/src/components/select.tsx": ["button", "icon"],
  "ui/src/components/text-field.tsx": ["icon-button", "tooltip"],
  "ui/src/components/toast.tsx": ["icon", "icon-button"],
}

/**
 * `ui/src/components/*.tsx` was 45 before this change and is **38** after it. A bound rather than a
 * name list, because ruling 13 pins the FORK and a v1-only widget forks nothing — see the header.
 * It may fall freely; raising it means adding a v1 component under a ruling that says new work is
 * v2, so raise it only with a reason written next to it.
 */
const V1_COMPONENT_CEILING = 38

/** Measured totals, pinned so the ledger stays a measurement rather than an aspiration. */
const V1_CALL_SITE_FILES = 88
const V1_CALL_SITE_PAIRS = 162

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
    expect(SWEPT.specifiers, "no forked-widget import found at all — SPECIFIER_PATTERNS is broken").toBeGreaterThan(200)
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
    expect(FORKED_WIDGETS.length, "the forked-pair count moved — reconcile FORKED_WIDGETS").toBe(13)
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
    const inUi = join(PACKAGES, "ui", "src", "components", "select.tsx")
    expect(classify(inUi, "./button", forked)).toEqual({ widget: "button", side: "v1" })
    expect(classify(inUi, "../v2/components/button-v2", forked)).toEqual({ widget: "button", side: "v2" })
    expect(classify(inUi, "./select-groups", forked)).toBeUndefined()
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
