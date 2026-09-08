import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * **Shrink-only ledger for the two shapes that turn a failed read into an empty screen.**
 *
 * 🔴 Ruling 2 has two halves — *a failed mutation never reports success* and *an unavailable
 * subsystem names itself instead of rendering empty* — and the whole-tree review found the second
 * one violated in every layer of the app, by subsystems sharing no code. The cause is not
 * carelessness: **nothing in the types distinguished an empty answer from a missing one**, so each
 * viewer re-derived the distinction in its own render expression and a good number of them lost it
 * on the way. `utils/settled-resource.ts` and `utils/list-state.ts` are the types. This file is the
 * lever that stops the population growing back.
 *
 * **Two forms, counted per file, and both may only go DOWN.**
 *
 * **A — a bare `createResource` call.** The rule is *use `createSettledResource`*, and the reason is
 * mechanical rather than stylistic: an errored resource **throws from its own accessor**, `.latest`
 * throws too (an `initialValue` sets `resolved` and does not save it), and `initialValue` also
 * erases the difference between *not asked* and *answered with nothing*. All three are invisible at
 * the call site, which is why a first sweep of this tree classified `initialValue: []` sites as
 * guarded and was wrong about every one.
 *
 * **B — an error handler whose whole body is an empty collection.** `.catch(() => [])`,
 * `catch { return {} }`. This is the pattern's name in one expression: *a failure folded into the
 * value an empty result produces.* Once folded, no caller downstream can ever recover the
 * difference, so the screen at the end of the chain cannot tell the truth even if it wants to.
 *
 * ⚠️ **What is deliberately NOT counted, because a threshold that fires on normal is not a
 * threshold.** Each exclusion cost a measured false-positive population:
 *
 * - **`.catch(() => undefined)`.** `undefined` is the honest value for *no answer*, and it is what
 *   the sanctioned guard uses next to a state check. Counting it would flag the fix.
 * - **`.catch(() => {})`** — that `{}` is an empty arrow BODY, not an object literal: a
 *   fire-and-forget on a void promise. Nine of the first 28 matches were this, and none was a fold.
 *   An object-literal default is written `=> ({})` and IS counted.
 * - **A `try`/`catch` around synchronous local code** — a `JSON.parse` of `localStorage`, a
 *   `toLocaleTimeString`. A corrupt local cache falling back to `[]` is not a subsystem lying about
 *   its state. The `catch`-block form is counted only when the preceding {@link ASYNC_WINDOW}
 *   characters contain `await ` or `.then(`, which is what separated the four real folds from the
 *   three innocent parses.
 * - **Test files.** A scan over source text also reads test titles and fixture strings, and a
 *   ledger line for a file that does not do the thing makes the ledger's own claim false. The rule
 *   is about what a viewer renders, so `src` minus `*.test.*` is the scope, and it is stated rather
 *   than assumed.
 *
 * ⚠️ **The remaining populations are not all bugs, and the ledger does not claim they are.** It
 * records what exists so the next one fails the gate. `utils/instance-fetch.ts`'s
 * `res.text().catch(() => "")` is the clearest example of a defensible line: it is already inside
 * the fault path, building the message for a failure it has diagnosed.
 *
 * **When you convert one, lower its line — and delete the line at zero.** A stale entry fails as
 * loudly as a new one, so this cannot rot into a rubber stamp.
 */

const APP_SRC = resolve(import.meta.dir, "..")

/** The one module allowed to call `createResource`: the wrapper every other caller goes through. */
const THE_WRAPPER = "utils/settled-resource.ts"

/**
 * `createResource(` as a CALL. The lookbehind rejects `createSettledResource(` and any member
 * access, and requiring the paren means an `import { createResource }` line is not a call site.
 */
const BARE_RESOURCE = /(?<![A-Za-z0-9_$.])createResource\s*\(/g

/** `.catch(e => [])` and `.catch(() => ({}))`. `{}` only with parentheses — see the note above. */
const CATCH_ARROW =
  /\.catch\s*\(\s*(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*=>\s*(\(\s*(?:\[\s*\]|\{\s*\}|""|''|0)\s*\)|\[\s*\]|""|''|0)(?![A-Za-z0-9_$.])/g

/** `catch { return [] }`, counted only when the guarded work was asynchronous. */
const CATCH_BLOCK = /\bcatch\s*(?:\([^()]*\))?\s*\{\s*return\s+\(?\s*(\[\s*\]|\{\s*\}|""|''|0)(?![A-Za-z0-9_$.])/g

/** How far back to look for the `await`/`.then(` that makes a `catch` block a subsystem read. */
const ASYNC_WINDOW = 400

/**
 * Measured against `packages/app/src` on 2026-09-02, after the six list viewers named in the review
 * were converted. Every number may only DECREASE; a file that reaches zero loses its line.
 */
const LEDGER: { resources: Record<string, number>; folds: Record<string, number> } = {
  resources: {
    "app.tsx": 2,
    "apps/system-load.ts": 1,
    "components/agent-config-dialog.tsx": 1,
    "components/dialog-select-directory-v2.tsx": 2,
    "components/dialog-select-server.tsx": 1,
    "components/memory-remembered.tsx": 3,
    "components/project-indicator.tsx": 2,
    "components/prompt-input.tsx": 1,
    "components/settings-v2/appearance.tsx": 1,
    "components/settings-v2/computer.tsx": 1,
    "components/settings-v2/general.tsx": 4,
    "components/settings-v2/identity.tsx": 1,
    "components/settings-v2/instance-resources.tsx": 1,
    "components/settings-v2/messengers.tsx": 3,
    "components/settings-v2/models.tsx": 1,
    "components/settings-v2/nova-health.tsx": 2,
    "components/settings-v2/policies.tsx": 2,
    "components/settings-v2/project.tsx": 2,
    "components/settings-v2/servers.tsx": 1,
    "components/titlebar-tab-strip.tsx": 1,
    "components/titlebar.tsx": 1,
    "context/global.tsx": 1,
    "context/language.tsx": 1,
    "context/models.tsx": 1,
    "pages/contacts.tsx": 3,
    "pages/debug.tsx": 5,
    "pages/directory-layout.tsx": 1,
    "pages/files.tsx": 3,
    "pages/memory-graph.tsx": 3,
    "pages/new-session.tsx": 1,
    "pages/recipes.tsx": 1,
    "pages/session/composer/session-composer-region-controller.ts": 1,
    "pages/session/composer/session-lost-folder-dock.tsx": 1,
    "pages/session/composer/session-responder-dock.tsx": 1,
    "pages/session/timeline/model.ts": 1,
    "pages/skills.tsx": 2,
    "utils/persist.ts": 1,
  },
  folds: {
    "components/dialog-select-directory-v2.tsx": 1,
    "components/dialog-select-file.tsx": 2,
    "components/directory-picker-domain.ts": 2,
    "components/memory-remembered.tsx": 1,
    "components/settings-v2/general.tsx": 1,
    "components/settings-v2/servers.tsx": 1,
    "context/notification.tsx": 1,
    "pages/contacts.tsx": 2,
    "pages/debug.tsx": 1,
    "pages/session/timeline/native-timeline.tsx": 1,
    "utils/instance-fetch.ts": 1,
    "utils/session-pending-api.ts": 1,
  },
}

/**
 * Remove comments while leaving strings intact.
 *
 * ⚠️ A regex over raw source counts PROSE, and this tree documents its own defects in prose beside
 * the code — `createResource` and `.catch(() => [])` both appear in comments explaining why not to
 * write them. A naive `//`-to-end-of-line strip is not enough either: it eats the tail of every
 * `"https://…"`, which can swallow real code on the same line. So this walks the text and tracks
 * which of the six lexical modes it is in. Newlines survive, so a match's line number is still the
 * line number in the real file.
 */
export function stripComments(text: string): string {
  let out = ""
  let i = 0
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line"
        i += 2
        continue
      }
      if (c === "/" && next === "*") {
        mode = "block"
        i += 2
        continue
      }
      if (c === "'") mode = "single"
      else if (c === '"') mode = "double"
      else if (c === "`") mode = "template"
      out += c
      i += 1
      continue
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code"
        out += c
      }
      i += 1
      continue
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code"
        i += 2
        continue
      }
      if (c === "\n") out += c
      i += 1
      continue
    }
    // Inside a string: an escape consumes two characters, replaced by two spaces so offsets hold.
    if (c === "\\") {
      out += "  "
      i += 2
      continue
    }
    if ((mode === "single" && c === "'") || (mode === "double" && c === '"') || (mode === "template" && c === "`"))
      mode = "code"
    out += c
    i += 1
  }
  return out
}

export interface Site {
  readonly line: number
  readonly source: string
}

/** Both detectors over one module's text. Exported so the controls can aim them at a literal. */
export function scanText(raw: string): { resources: Site[]; folds: Site[] } {
  const text = stripComments(raw)
  const lines = text.split("\n")
  const lineAt = (index: number) => text.slice(0, index).split("\n").length
  const site = (index: number): Site => ({ line: lineAt(index), source: lines[lineAt(index) - 1]?.trim() ?? "" })

  const resources: Site[] = []
  const folds: Site[] = []
  for (const match of text.matchAll(BARE_RESOURCE)) resources.push(site(match.index))
  for (const match of text.matchAll(CATCH_ARROW)) folds.push(site(match.index + match[0].length))
  for (const match of text.matchAll(CATCH_BLOCK)) {
    const before = text.slice(Math.max(0, match.index - ASYNC_WINDOW), match.index)
    if (!before.includes("await ") && !before.includes(".then(")) continue
    folds.push(site(match.index + match[0].length))
  }
  return { resources, folds }
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
    if (entry.includes(".test.")) continue
    acc.push(full)
  }
  return acc
}

function scan() {
  const resources: Record<string, Site[]> = {}
  const folds: Record<string, Site[]> = {}
  for (const file of sourceFiles(APP_SRC)) {
    const rel = relative(APP_SRC, file).replaceAll("\\", "/")
    if (rel === THE_WRAPPER) continue
    const found = scanText(readFileSync(file, "utf8"))
    if (found.resources.length) resources[rel] = found.resources
    if (found.folds.length) folds[rel] = found.folds
  }
  return { resources, folds }
}

/** Every disagreement between a ledger line and the tree, each naming the LINES, not just a total. */
function drift(found: Record<string, Site[]>, allowed: Record<string, number>, form: string): string[] {
  const out: string[] = []
  for (const file of new Set([...Object.keys(found), ...Object.keys(allowed)]).values()) {
    const sites = found[file] ?? []
    const cap = allowed[file] ?? 0
    if (sites.length === cap) continue
    const where = sites.map((s) => `\n      ${file}:${s.line}  ${s.source}`).join("")
    out.push(
      sites.length > cap
        ? `${file}: ${sites.length} ${form}, ledger allows ${cap}.${where}`
        : `${file}: ${sites.length} ${form}, ledger still says ${cap}. Lower it to ${sites.length}${cap && !sites.length ? " (delete the line)" : ""}.${where}`,
    )
  }
  return out
}

describe("the settled-resource ledger", () => {
  test("no new bare createResource, and no ledger line is stale", () => {
    expect(drift(scan().resources, LEDGER.resources, "bare createResource call(s)")).toEqual([])
  })

  test("no new handler folds a failed read into an empty collection", () => {
    expect(drift(scan().folds, LEDGER.folds, "error handler(s) folding into an empty value")).toEqual([])
  })

  test("POSITIVE CONTROL — the detectors flag a module that does the thing", () => {
    // ⚠️ A guard reporting zero because it matches NOTHING is indistinguishable from a clean tree,
    // and this one reports zero on a healthy repo by design. So it is aimed at a module written to
    // be caught: every shape the ledger claims to see, and nothing else.
    const bad = `
      import { createResource } from "solid-js"
      export function Panel() {
        const [rows] = createResource(source, async () => {
          try {
            return await listThings(base)
          } catch {
            return [] as Thing[]
          }
        })
        const [more] = createResource(source, (s) => listMore(s).catch(() => []))
        const [shape] = createResource(source, (s) => readShape(s).catch(() => ({})))
        return rows()
      }
    `
    const found = scanText(bad)
    expect(found.resources.map((s) => s.source)).toEqual([
      "const [rows] = createResource(source, async () => {",
      "const [more] = createResource(source, (s) => listMore(s).catch(() => []))",
      "const [shape] = createResource(source, (s) => readShape(s).catch(() => ({})))",
    ])
    expect(found.folds.map((s) => s.source)).toEqual([
      "const [more] = createResource(source, (s) => listMore(s).catch(() => []))",
      "const [shape] = createResource(source, (s) => readShape(s).catch(() => ({})))",
      "return [] as Thing[]",
    ])
  })

  test("NEGATIVE CONTROL — the sanctioned shapes and the prose about them are NOT flagged", () => {
    // Each line here is a real shape from this tree that an earlier draft of these regexes caught.
    const good = `
      /** Never write createResource(...) directly, and never .catch(() => []) a listing. */
      // createResource(source, () => x.catch(() => []))
      const [rows] = createSettledResource(source, (s) => listThings(s))
      const guarded = read(s).catch(() => undefined)
      void sync.updateConfig(patch).catch(() => {})
      const url = "https://example.invalid/a//b" // a path with // in a string
      function order(): string[] {
        try {
          return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]
        } catch {
          return []
        }
      }
    `
    const found = scanText(good)
    expect(found.resources).toEqual([])
    expect(found.folds).toEqual([])
  })

  test("the scan is reading real files (vacuity)", () => {
    // Every number above is a `.match()` over text read from disk. A broken walk makes them all
    // zero and every assertion agree with itself forever, so the ledger's own non-zero lines are
    // what prove it is still looking.
    const found = scan()
    expect(sourceFiles(APP_SRC).length).toBeGreaterThan(100)
    expect(Object.keys(found.resources).length).toBeGreaterThan(10)
    expect(Object.keys(found.folds).length).toBeGreaterThan(5)
    // The six viewers this ledger opened with are converted, and must stay converted.
    for (const converted of [
      "pages/trash.tsx",
      "pages/calendar.tsx",
      "pages/notes.tsx",
      // The largest single conversion in the tree — thirteen bare reads in one file, every one of
      // them behind an api helper that swallowed its own rejection into a plausible empty value.
      "pages/home-screen/community-network.tsx",
    ])
      expect(found.resources[converted], `${converted} went back to a bare createResource`).toBeUndefined()
  })
})
