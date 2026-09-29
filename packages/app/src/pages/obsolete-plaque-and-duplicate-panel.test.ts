import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * 🔴 **THE OBSOLETE PLAQUE AND THE DUPLICATED PANEL ARE OUT, AND THE ONE OFFICIAL ROAD STAYS.**
 *
 * Owner, 2026-09-29, on a running build: a session showed a plaque carrying `Stop` and `See changes`.
 * Pressing `See changes` opened a right panel with `0 Changes` and `All files` tabs and no way to
 * close it. The owner's ruling: the plaque is inherited residue and goes "with its roots", and the
 * official route to those tabs is the context ring — AGENTS.md's *"clicking context indicator leads
 * to the current stats"*, the character sheet.
 *
 * ⚠️ **THE PREMISE WAS HALF WRONG, AND THAT MATTERS MORE THAN THE REMOVAL.** The context inspector
 * did NOT already carry a file list or a changes list: `SessionContextTab` renders token breakdown,
 * compaction history and prompt portability, and imports no `FileTree` at all. So deleting the pill
 * without porting would have removed the app's ONLY file browser and diff view, silently, and the
 * inspector would not have replaced them. Hence `SessionFilesSection`: the two `FileTree` lists were
 * MOVED into the inspector, not reimplemented, and this file pins that they are still there.
 *
 * The `See changes` / `Stop` / `Retry` strings were HARDCODED ENGLISH in the JSX, never an i18n key,
 * which is why they are pinned as literals here: a translation-key search does not find them.
 */
const SESSION = readFileSync(path.resolve(import.meta.dir, "session.tsx"), "utf8")
const PANEL = readFileSync(path.resolve(import.meta.dir, "session", "session-side-panel.tsx"), "utf8")
const SECTION = readFileSync(path.resolve(import.meta.dir, "session", "session-files-section.tsx"), "utf8")
const CONTEXT = readFileSync(path.resolve(import.meta.dir, "..", "components", "session", "session-context-tab.tsx"), "utf8")

/** Prose quotes the defect it describes, so structural assertions read code, not comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

describe("the obsolete plaque is gone, with its roots", () => {
  test("🔴 the Stop / See changes / Retry banner is not rendered anywhere", () => {
    // Literals, because these were never i18n keys — which is exactly how they survived a sweep.
    for (const literal of ["See changes", "This chat needs attention.", "This chat is recovering automatically."]) {
      expect(code(SESSION), `the obsolete plaque still renders ${JSON.stringify(literal)}`).not.toContain(literal)
    }
  })

  test("the machinery that existed only to serve the plaque is removed, not left dormant", () => {
    // `executionAttention` fed only that banner, and `showChangedFiles` was the See-changes handler
    // that opened the very panel the owner could not close.
    for (const dead of ["executionAttention", "showChangedFiles", "recoveryChanges", "visibleExecutionAttention"]) {
      expect(code(SESSION), `${dead} survived the plaque removal`).not.toContain(dead)
    }
  })
})

describe("the panel keeps ONE official road, and the file lists live in the inspector", () => {
  test("🔴 the duplicated Review tab and the Changes/All files pill are gone from the panel", () => {
    const panel = code(PANEL)
    expect(panel, "the Review tab is back").not.toContain('value="review"')
    expect(panel, "the Changes/All files pill is back").not.toContain('value="changes"')
    expect(panel, "the All files pill trigger is back").not.toContain('value="all"')
  })

  test("🔴 the context inspector is still rendered, and still closes", () => {
    // The official route must survive the removal, and it must still be dismissible — the owner's
    // complaint was a panel with no way out, so the close affordance is load-bearing.
    expect(panel_has("SessionContextTab")).toBe(true)
    expect(code(PANEL)).toContain('tabs().close("context")')
  })

  test("🔴 the file list and the changes list were PORTED, not dropped", () => {
    // This is the assertion that would have caught the wrong removal: both trees exist, and both
    // original click behaviours are preserved (a changed file focuses the diff; a listed file opens
    // a tab).
    const section = code(SECTION)
    expect(section, "the changes list is gone — the app has no diff view").toContain("allowed={diffFiles()}")
    expect(section, "the file list is gone — the app has no file browser").toContain("modified={diffFiles()}")
    expect(section, "a changed file no longer focuses its diff").toContain("props.focusDiff(node.path)")
    expect(section, "a listed file no longer opens as a tab").toContain("props.openFile(node.path)")
    // And the section is mounted inside the inspector, not merely defined.
    expect(code(PANEL)).toContain("<SessionFilesSection")
    expect(code(CONTEXT)).toContain("props.files")
  })

  test("the diff KIND map registers the file and its directories, as the pill did", () => {
    // Dropping the file-level registration colours directories but leaves the changed file itself
    // uncoloured — a regression that looks like a theming bug and is not.
    const section = code(SECTION)
    expect(section).toContain('out.set(file, kind)')
    expect(section).toContain('out.set(dir, merge(out.get(dir), kind))')
  })
})

function panel_has(needle: string) {
  return code(PANEL).includes(needle)
}
