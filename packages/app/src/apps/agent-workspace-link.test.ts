import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * BROWSING A COLLEAGUE'S OWN WORKSPACE (owner, 2026-08-22).
 *
 * 🔴 A colleague keeps its own workspace even when assigned to a project: the floor grants it
 * (`AgentPlugin.scratchDirsFor`) and the prompt tells the colleague about it
 * (`SystemCompose.workspaceSection`). Both of those are invisible to the USER — the notes, drafts and
 * probe scripts written there were real files with no route to open them.
 *
 * Three links have to hold for the route to work, and each is in a different package, so a source
 * ledger is what can see all three at once:
 *   1. the roster response stamps `workspace` (it is derived, and the client cannot compute it)
 *   2. the config dialog reads it from the AGENT rather than guessing a path
 *   3. `/files` honours `?path=`
 * Break any one and the link renders, goes somewhere wrong or not at all, and nothing else notices.
 */

const read = (...segments: string[]): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(path.join(here, "..", "..", "..", ...segments), "utf8")
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("a colleague's workspace is reachable", () => {
  test("1. the roster stamps the workspace path server-side", () => {
    const source = read("server", "src", "handlers", "agent.ts")
    expect(source).toMatch(/workspace:\s*Scratch\.forAgent/)
  })

  test("2. the dialog reads it from the agent, never derives it", () => {
    const source = read("app", "src", "components", "agent-config-dialog.tsx")
    expect(source).toContain("workspace")
    // 🔴 The client must NOT build this path. The scratch root is under the instance's data
    // directory, which the app does not know — a derived path would link to a folder that is not
    // there, and on a remote instance it would name one on the wrong machine entirely.
    expect(source).not.toMatch(/scratch[\/]/i)
  })

  test("3. the files page opens where it is asked to", () => {
    const source = read("app", "src", "pages", "files.tsx")
    expect(source).toContain("useSearchParams")
    expect(source).toMatch(/params\.path/)
  })

  test("the link points at the files route with the path encoded", () => {
    const source = read("app", "src", "components", "agent-config-dialog.tsx")
    // Encoded because a Windows path carries a colon and backslashes; an unencoded href would
    // truncate at the drive letter.
    expect(source).toMatch(/\/files\?path=\$\{encodeURIComponent/)
  })
})
