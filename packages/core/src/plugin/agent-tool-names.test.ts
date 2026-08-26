import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * 🔴 **A tool named in an agent prompt must be a tool that EXISTS, spelled the way it is callable.**
 *
 * Found 2026-08-26 by the prompt audit: the `explore` agent's brief said `Glob` / `Grep` / `Read`
 * while the callable names are `glob` / `grep` / `read`. ⭐ **This is the one prompt defect that
 * produces a hard `Unknown tool` rather than a weaker answer** — a model that follows the instruction
 * literally emits a call that cannot dispatch.
 *
 * The instance was fixed. This is the CLASS: nothing otherwise stops the next prompt from doing it
 * again, and the failure is invisible until a model actually tries.
 *
 * ⚠️ **The tool list is DERIVED, never hand-kept.** A copy of the names beside the names is a subset
 * that goes stale silently — it would still pass on the day a tool is renamed, which is exactly when
 * this check has something to say.
 */
const TOOL_DIR = path.join(import.meta.dir, "../tool")
const PROMPT_FILES = ["agent.ts"].map((f) => path.join(import.meta.dir, f))

const toolNames = (): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const entry of fs.readdirSync(TOOL_DIR)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
    const source = fs.readFileSync(path.join(TOOL_DIR, entry), "utf8")
    const declared = /^export const name = "([a-z][a-z0-9_]*)"/m.exec(source)
    if (declared) names.add(declared[1]!)
  }
  return names
}

describe("tool names in shipped agent prompts", () => {
  test("the derivation itself works — a broken scan would pass every check below", () => {
    // ⚠️ Without this the whole file is vacuous: an empty set finds no offenders and reports clean.
    const names = toolNames()
    expect(names.size).toBeGreaterThan(8)
    for (const known of ["read", "bash", "glob", "grep", "spawn", "wait"]) expect(names).toContain(known)
  })

  test("🔴 no prompt names a tool in the wrong case", () => {
    const names = toolNames()
    const offenders: string[] = []
    for (const file of PROMPT_FILES) {
      const source = fs.readFileSync(file, "utf8")
      for (const tool of names) {
        // Two positions where a capitalised word is unambiguously a TOOL reference rather than
        // ordinary English: inside backticks, or straight after "use". "Read it and follow it" is
        // prose and must not fire; "Use Read" and "`Read`" are the defect.
        const backticked = new RegExp("\\\\`(" + tool + ")\\\\`", "gi")
        const used = new RegExp("\\buse\\s+(" + tool + ")\\b", "gi")
        for (const pattern of [backticked, used])
          for (const match of source.matchAll(pattern))
            if (match[1] !== tool) offenders.push(`${path.basename(file)}: "${match[0]}" — callable name is "${tool}"`)
      }
    }
    expect(offenders).toEqual([])
  })
})
