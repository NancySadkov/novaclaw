import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * EVERY CABINET IS CAPPED, AND EACH ON ITS OWN.
 *
 * 🔴 Auto-extracted facts used to be written to `session:<id>` and promoted into `global` by the
 * consolidation pass, where `prune({scope: "global"})` bounded them. Filing them in the officer's
 * cabinet (2026-08-22) stopped that leak — and removed the only bound they had. So the background
 * pass now prunes each `agent:` scope too.
 *
 * ⚠️ A SOURCE ledger, matching `kb-scan-hydration.test.ts`'s reasoning: the behaviour needs the WASM
 * engine, which is too heavy for the gate and lives in `kb-graph-forgetting.smoke.ts` — where it IS
 * proven end to end (two cabinets, the loud one capped, the quiet one untouched; A/B'd with a shared
 * budget, which evicts the quiet one and fails). What can be checked mechanically here is the shape
 * the guarantee rests on: discovered per scope, pruned per scope.
 */
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "kb-graph", "memory.ts"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("the background pass bounds every cabinet", () => {
  test("the household pile is still capped", () => {
    expect(source).toMatch(/prune\(\{\s*scope:\s*"global"/)
  })

  test("cabinets are DISCOVERED rather than guessed", () => {
    // A hardcoded list would go stale the first time somebody is hired.
    expect(source).toContain('stagedScopes("agent:")')
  })

  test("🔴 each cabinet is pruned SEPARATELY, never one cap across the prefix", () => {
    // The property: one talkative officer must not evict another's memories. A single
    // `prune({scopePrefix})` call, or a budget shared across the loop, breaks it — and the smoke
    // test fails on exactly the quiet colleague when it does.
    const at = source.indexOf('stagedScopes("agent:")')
    expect(at).toBeGreaterThan(0)
    // The discovery call is INSIDE the loop header, so the `for` precedes it…
    expect(source.slice(Math.max(0, at - 200), at)).toMatch(/for \(const scope of/)
    // …and the body prunes that one scope, with the same cap the household pile gets.
    expect(source.slice(at, at + 300)).toMatch(/prune\(\{\s*scope,\s*maxStaged:\s*stagedCap\s*\}\)/)
  })
})
