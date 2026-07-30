import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { parse } from "node:path"
import { Global } from "@novaclaw/core/global"
import { SCRATCH_ROOT, scratchHome } from "@novaclaw/core/kb-graph/wasm-engine"

// AGENTS.md design principle 11: outside the home, the OS temp dir and the working folder, the
// filesystem is READ-ONLY to us. This is the mechanical half — the principle on its own is the class
// of claim ruling 1 says does not exist unless something fails when it is violated.
//
// The instance that produced it: the KB memory engine littered the drive root with one `kbmem_<pid>`
// directory per open (129 of them / 249 MB at the worst), then with a `C:\novaclaw-kbmem` junction
// once that was "fixed". Both were invisible to every test, because nothing looked outside the tree.

describe("design principle 11: we do not write outside the home", () => {
  test("the KB scratch root resolves inside the instance home, not at the drive root", () => {
    // On win32 SCRATCH_ROOT is `scratchHome()` with the drive letter stripped, so it must keep every
    // other segment. A single-segment root path IS the drive root and is the bug this pins.
    expect(SCRATCH_ROOT.split("/").filter(Boolean).length).toBeGreaterThan(1)

    // …and it must be the SAME directory as the home path, not merely a deep-looking one.
    const home = scratchHome().replaceAll("\\", "/")
    const stripped = home.replace(/^[A-Za-z]:/, "")
    expect(SCRATCH_ROOT.replaceAll("\\", "/")).toBe(process.platform === "win32" ? stripped : home)
  })

  test("the scratch home is under the instance cache dir", () => {
    const cache = Global.Path.cache.replaceAll("\\", "/")
    expect(scratchHome().replaceAll("\\", "/").startsWith(cache)).toBe(true)
  })

  test("the engine is never handed a drive-lettered path (it fails getcwd) nor a backslash one", () => {
    expect(SCRATCH_ROOT).not.toMatch(/^\/?[A-Za-z]:/)
    expect(SCRATCH_ROOT).not.toContain("\\")
    expect(SCRATCH_ROOT.startsWith("/")).toBe(true)
  })

  test("no novaclaw-shaped entry is left at the root of the current drive", () => {
    // The regression is observable from outside the tree or not at all — that is why it survived two
    // rounds of "fixes". Scoped to our own names so an unrelated C:\ entry can never fail the gate.
    const driveRoot = parse(process.cwd()).root
    let entries: string[]
    try {
      entries = readdirSync(driveRoot)
    } catch {
      return // unreadable root (CI container, permissions) — nothing to assert
    }
    const ours = entries.filter((n) => /^(kbmem_|novaclaw-kbmem)/i.test(n))
    expect(ours).toEqual([])
  })
})
