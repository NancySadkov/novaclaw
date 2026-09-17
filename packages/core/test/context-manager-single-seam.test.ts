import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * ONE SEAM FOR CONTEXT.
 *
 * 🔴 Owner, 2026-09-17: *"any core part doing anything with context should never go around
 * ContextManager. Otherwise we risk accumulating more such bugs."* The bug in question was a live
 * prompt indicator reading a stale capture file because it reached context through a route that was
 * not the manager. The rule is only real if a second door cannot be opened quietly, so this is a
 * source ratchet rather than a comment: `context-epoch.ts` may be imported only by
 * `context-manager.ts`.
 *
 * `SessionContextEpochTable` (the SQL table, in `session/sql.ts`) is a STORAGE detail and is not
 * covered — a test fixture may build rows directly. What is covered is importing the epoch MODULE,
 * which is the accessor this seam exists to be the only one of.
 */
const SRC = resolve(import.meta.dir, "..", "src")
const IMPORT_FROM_EPOCH = /from\s+["'][^"']*context-epoch["']/
/** The manager is the seam; the epoch module is itself. Nothing else may import the epoch. */
const ALLOWED = new Set([join("session", "context-manager.ts"), join("session", "context-epoch.ts")])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "migrations") continue
      sourceFiles(full, acc)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full)
  }
  return acc
}

describe("context has exactly one seam", () => {
  test("only ContextManager imports the context epoch", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8")
      if (!IMPORT_FROM_EPOCH.test(source)) continue
      const rel = relative(SRC, file)
      if (!ALLOWED.has(rel)) offenders.push(rel.replaceAll("\\", "/"))
    }
    expect(
      offenders,
      "these files reach context through the storage module instead of ContextManager — route them through `session/context-manager.ts`",
    ).toEqual([])
  })
})
