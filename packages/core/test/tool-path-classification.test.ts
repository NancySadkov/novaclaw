import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The sweep, as a standing guard rather than a one-off audit.
//
// Every tool that turns CALLER-SUPPLIED input into a filesystem path must contain it through
// `LocationMutation.resolve`, which canonicalizes via realPath and so catches both `../..` escapes and
// symlinks pointing out of the workspace. Two rounds of this have already been got wrong:
//   · glob/grep resolved `input.path` with no containment at all (an absolute path was searched silently,
//     and grep returns matching LINES, i.e. content);
//   · messenger contained upload/download LEXICALLY (`path.resolve` + `FSUtil.contains`), which does not
//     resolve symlinks, so a link inside the workspace read/wrote outside it.
// Both looked fine by inspection. A grep is the only thing that reliably notices the next one.

const TOOL_DIR = path.join(import.meta.dir, "..", "src", "tool")

/** `path.resolve(location.directory, …input…)` — turning model input into a real path. */
const RESOLVES_INPUT = /path\.resolve\(\s*location\.directory\s*,\s*[^)]*\binput\b/

/** The lexical containment that superseded nothing — it cannot see through a symlink. */
const LEXICAL_CONTAINMENT = /FSUtil\.contains\(\s*location\.directory/

const sources = fs
  .readdirSync(TOOL_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(TOOL_DIR, name), "utf8") }))

describe("tool path classification", () => {
  test("the sweep actually has files to look at", () => {
    expect(sources.length).toBeGreaterThan(10)
  })

  test("a tool that resolves caller input against the location must classify it", () => {
    const offenders = sources
      .filter((file) => RESOLVES_INPUT.test(file.text))
      .filter((file) => !file.text.includes("mutation.resolve"))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("no tool contains a path lexically instead of canonically", () => {
    // `FSUtil.contains(location.directory, …)` cannot see through a symlink. Containment belongs to
    // LocationMutation; this pattern is how the messenger hole survived review.
    const offenders = sources.filter((file) => LEXICAL_CONTAINMENT.test(file.text)).map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("the file tools all still route through LocationMutation (the guard can actually fail)", () => {
    // A negative control for the guard itself: if these stopped classifying, the checks above must notice.
    for (const name of ["read.ts", "write.ts", "edit.ts", "apply-patch.ts", "trash.ts", "glob.ts", "grep.ts"]) {
      const file = sources.find((item) => item.name === name)
      expect(file, `${name} missing from ${TOOL_DIR}`).toBeDefined()
      expect(file!.text, `${name} no longer classifies its paths`).toContain("mutation.resolve")
    }
  })
})
