import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * 🔴 THE WORK-LOG IS ONE FILE, IT IS APPENDED TO, AND IT IS CAPPED.
 *
 * **What it replaces, measured 2026-09-29.** Compaction minted a fresh `oldctx-<DATETIME>.txt` plus an
 * `oldlog-<date>-<time>-<n>.json` sibling on every fold. Nova's `tmp` reached **5,187 files, 0.66 GB**,
 * written about every 20 s, and nothing anywhere trimmed them: the scratch horizon is keyed on the age
 * of the *session* (`scratch/horizon.ts` reads `chat.born`), so a session created 0.3 days ago
 * suppressed pruning of files days old. A user action — starting a new chat — reset the retention clock
 * on a folder that was already full.
 *
 * Three properties, and each one is a way the old shape failed, so each is pinned separately:
 *   1. ONE name. A chain is not greppable, and a varying name is tokens spent on a filename forever.
 *   2. APPEND. A new file per fold is what made the pile.
 *   3. CAPPED. One file without a cap is the same disk problem in one lump — and a worse one, because
 *      an agent can no longer find anything in a pile.
 */
const ROOT = join(import.meta.dir, "..", "..", "..")
const OLD_CONTEXT = "packages/core/src/session/old-context.ts"
const CONFIG_LOG = "packages/core/src/config/log.ts"
const LOG_SETTINGS = "packages/core/src/observability/log-settings.ts"

const parsed = (relative: string) => stripComments(readFileSync(join(ROOT, relative), "utf8"), relative)

describe("the work-log is one fixed file", () => {
  const source = parsed(OLD_CONTEXT)

  test("the name carries no timestamp and no counter", () => {
    // A varying name makes the tombstone vary, which costs prefix-cache on the segment AND makes the
    // agent guess which of N files holds what.
    expect(source).toContain('export const HISTORY_NAME = "history.json"')
    expect(source).not.toMatch(/`oldctx-/)
    expect(source).not.toMatch(/`oldlog-/)
  })

  test("the file path takes no time and no identity", () => {
    // `file({ scratchFolder })` and nothing else. A parameter that is not used to build a name is a
    // parameter a caller will pass a different value to next time, and the name starts varying.
    expect(source).toMatch(/export const file = \(input: \{ readonly scratchFolder: string \}\)/)
    expect(source).not.toContain("OldContext.identity")
  })

  test("the tombstone names the log in the house wording, with no placeholder", () => {
    // `prompt-manager.test.ts` already emitted "Earlier work-log:" for the grounding field, so this
    // wording is the existing convention rather than a new one — the two must not drift apart.
    expect(source).toContain("Earlier work-log: ${displayPath(file)}")
    expect(source).not.toContain("%DATETIME%")
  })
})

describe("the work-log is appended to, and bounded", () => {
  const source = parsed(OLD_CONTEXT)

  test("there is exactly one writer, and it appends", () => {
    expect(source).toMatch(/export const append = async \(/)
    // The old shape had three writers (save, saveWorkLog, and a counter loop) and all three are gone.
    expect(source).not.toContain("export const save")
    expect(source).not.toContain("saveWorkLog")
    expect(source).not.toContain("latestWorkLog")
  })

  test("🔴 the cap is read from config, not hard-coded at the write site", () => {
    // The owner bounds an agent's history from Settings → Storage. A constant here would make the
    // setting a decoration: the screen would save a number nothing reads.
    expect(source).toContain("LogSettings.workLogMaxBytes()")
    expect(OLD_CONTEXT).toBeTruthy()
  })

  test("the cap drops the OLDEST half, and never the newest entry", () => {
    // Halving rather than trimming-to-fit: a log cut to exactly the limit re-triggers on the next
    // fold, so the agent watches its history evaporate one entry at a time. The reclaim keeps the
    // NEWEST bytes and snaps FORWARD to a line boundary, each entry being one physical JSONL line; a
    // final line longer than the whole cap is left in place rather than truncated.
    expect(source).toMatch(/const trimToNewestHalf = async \(/)
    expect(source).toContain("const keep = Math.min(maxBytes, Math.floor(data.length / 2))")
    expect(source).toMatch(/while \(start < data\.length && data\[start\] !== 0x0a\)/)
    expect(source).toContain("data.subarray(start)")
  })

  test("a corrupt log is replaced, never refused", () => {
    // The log is JSONL and `append` never parses what is already there, so a torn or corrupt file
    // cannot refuse a fold; the bad line is dropped with the oldest half at the next reclaim.
    expect(source).not.toContain("JSON.parse")
    expect(source).toContain("await fs.appendFile(target")
    expect(source).toMatch(/while \(start < data\.length && data\[start\] !== 0x0a\)/)
  })

  test("a fixed name means a shared write path, so the write is serialised AND its temp name unique", () => {
    // Two defects of the same origin. Serialise because read-modify-write with one filename loses a
    // concurrent fold silently. Unique temp because a shared temp path is one crash away from ENOENT.
    expect(source).toContain("const writes = new Map<string, Promise<void>>()")
    expect(source).toMatch(/const previous = writes\.get\(target\)/)
    expect(source).toContain("randomUUID()}.tmp")
  })
})

describe("the cap is a real, bounded setting", () => {
  test("the key exists and is range-checked on the write path", () => {
    const config = parsed(CONFIG_LOG)
    expect(config).toContain("work_log_max_mb")
    expect(config).toMatch(/WorkLogMaxMb = Schema\.Int\.check\(Schema\.isBetween\(\{ minimum: 1, maximum: 4096 \}\)\)/)
  })

  test("the default is 256 MB and is declared once", () => {
    // Declared in log-settings (the config reader) and derived in old-context, so the dependency points
    // one way. Two independent 256s would drift, and the drift would be silent.
    const settings = parsed(LOG_SETTINGS)
    expect(settings).toContain("export const DEFAULT_WORK_LOG_MAX_MB = 256")
    expect(parsed(OLD_CONTEXT)).toContain("LogSettings.DEFAULT_WORK_LOG_MAX_MB")
  })

  test("a stored 0 or negative cannot make every compaction halve its own history away", () => {
    // Same clamp `maxAgeMs` already carries, for the same reason: `apply` takes the stored value
    // without decoding, so whichever door wrote the column, the writer must not be drivable into a loop.
    const settings = parsed(LOG_SETTINGS)
    expect(settings).toMatch(/Math\.max\(1, current\.work_log_max_mb \?\? DEFAULT_WORK_LOG_MAX_MB\)/)
  })
})
