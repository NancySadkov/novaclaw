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
const CONTEXT = readFileSync(
  path.resolve(import.meta.dir, "..", "components", "session", "session-context-tab.tsx"),
  "utf8",
)

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
  test("the inspector has separate Context, Changes and All files tabs", () => {
    const panel = code(PANEL)
    expect(panel, "the Review tab is back").not.toContain('value="review"')
    for (const value of ["context", "changes", "all"]) {
      expect(panel).toContain(`value="${value}"`)
    }
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
    expect(code(CONTEXT)).not.toContain("props.files")
    expect(code(PANEL)).toContain('mode={inspectorTab() === "changes" ? "changes" : "all"}')
  })

  test("🔴 nothing can OPEN the file tree any more, because there is no longer one to open", () => {
    // The dead end this removal created, found by sweeping the store's consumers rather than by
    // looking at the panel: `layout.fileTree` is still in the layout store, it still DEFAULTS
    // `opened` to true, and the session page still reserved a rail's width from the conversation
    // for it. So the pill's removal left a command (`mod+\`) that opened a panel rendering nothing,
    // with a permanent empty gap beside the chat. A user pressing it gets no file list and no way
    // to tell that anything happened.
    const commands = readFileSync(path.resolve(import.meta.dir, "session", "use-session-commands.tsx"), "utf8")
    expect(code(commands), "a command can still toggle the removed file tree").not.toContain("fileTree.toggle")
    expect(code(SESSION), "the conversation still reserves a rail for the removed tree").not.toContain(
      "layout.fileTree.width()",
    )
    expect(code(PANEL), "the side panel still reads the removed tree").not.toContain("layout.fileTree")
  })

  test("the file tree is populated for the INSPECTOR, which is what renders it now", () => {
    // The refresher used to be gated on the docked panel being open. Left pointing there, the
    // inspector's two lists would render against a tree nobody ever loaded.
    const session = code(SESSION)
    expect(session).toContain("if (!contextOpen()) return")
    expect(session).toContain('file.tree.refresh("")')
  })

  test("the KIND map is not re-inlined in the component, so it cannot drift from the tested copy", () => {
    // The semantics — a changed file AND its folders registered, a Windows path normalized — are
    // owned by `session-files-derive.test.ts`, which proves them by RUNNING them. What belongs here
    // is only the delegation: the first version of this port inlined a second copy of the kind map
    // and got it wrong in the one way that is invisible until a tree is miscoloured.
    const section = code(SECTION)
    expect(section, "the component inlines its own kind map again").toContain("diffKinds(props.diffs)")
    expect(section, "the component inlines its own path list again").toContain("diffPaths(props.diffs)")
    expect(section, "the component re-normalizes paths itself").not.toMatch(/replace(All)?\(/)
  })
})

function panel_has(needle: string) {
  return code(PANEL).includes(needle)
}
