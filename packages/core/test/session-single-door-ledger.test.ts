import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * ONE DOOR INTO EXISTENCE FOR A SESSION.
 *
 * 🔴 The one-chat-per-agent invariant is enforced inside `createSessionRecord`. That enforcement is
 * only worth anything if it is the ONLY way a session row can come into being — a guard with a way
 * around it is decoration. The owner's ask, 2026-08-23: *"a strong invariant about one session per
 * agent, and no dead code allowing spawning extra sessions for agent."*
 *
 * Three facts make the door single, and this ledger pins all three, because each is invisible to
 * every other instrument we have:
 *
 *   1. `SessionRecordEvent.Created` has exactly ONE publisher — `createSessionRecord`.
 *   2. `SessionTable` is INSERTED in exactly one place — the projector, which materialises that
 *      event and is therefore downstream of the guard rather than a second door.
 *   3. `createSessionRecord` is the only thing that publishes it, so every session in the system
 *      passed the guard.
 *
 * ⚠️ **Why a source ledger rather than a behavioural test.** A new `db.insert(SessionTable)` in some
 * future service would create sessions that work perfectly — they would just never have been asked
 * whether their agent already had a chat. Nothing would go red: not the typecheck, not the runtime,
 * not the invariant's own tests, which drive the seam they trust. The failure mode is silence, and a
 * regex over the tree is the instrument that can see it.
 *
 * If this test fails, the fix is almost never to add the new site to the allow-list. It is to route
 * the new caller through `createSessionRecord`.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const coreSrc = path.resolve(here, "../src")
const packages = path.resolve(here, "../../")

/** The ONE place a session row may be inserted, and the one place its birth event may be published. */
const INSERT_SITE = "core/src/session/projector.ts"
const PUBLISH_SITE = "core/src/session.ts"

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === "gen" || entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry)) continue
      if (/\.(test|smoke)\.tsx?$/.test(entry)) continue
      out.push(full)
    }
  }
  walk(root)
  return out
}

/** ⚠️ Comments stripped before matching — this file's own header names both sites on purpose. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")

/** `packages/<pkg>/src/...` with forward slashes, so a failure names something greppable. */
const label = (file: string) =>
  path
    .relative(packages, file)
    .replaceAll("\\", "/")
    .replace(/^([^/]+)\//, "$1/")

const sitesMatching = (pattern: RegExp): string[] => {
  const hits: string[] = []
  for (const dir of readdirSync(packages)) {
    const src = path.join(packages, dir, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of sourceFiles(src)) {
      if (pattern.test(code(readFileSync(file, "utf8")))) hits.push(label(file))
    }
  }
  return hits.sort()
}

describe("a session has exactly one door into existence", () => {
  test("the ledger's own instrument works", () => {
    // A guard on the guard: a scanner that finds nothing would make every assertion below vacuous.
    expect(sourceFiles(coreSrc).length).toBeGreaterThan(100)
  })

  test("SessionTable is INSERTED in exactly one place — the projector", () => {
    // Anything else writing this table creates a session that never met the invariant.
    expect(sitesMatching(/\.insert\(\s*SessionTable\s*\)/)).toEqual([INSERT_SITE])
  })

  test("SessionRecordEvent.Created has exactly one PUBLISHER — createSessionRecord", () => {
    // `publish(...Created)` is what the projector materialises, so a second publisher is a second
    // door even though it never touches the table itself.
    expect(sitesMatching(/\.publish\(\s*SessionRecordEvent\.Created/)).toEqual([PUBLISH_SITE])
  })

  test("the guard is still IN the one seam", () => {
    // The clauses, not the prose: a refactor that keeps the comment and drops the check would leave
    // every other test here green.
    const seam = code(readFileSync(path.join(coreSrc, "session.ts"), "utf8"))
    expect(seam).toContain("input.parentID === undefined")
    expect(seam).toContain("AgentV2.POSTURE_IDS.has(input.agent)")
  })
})
