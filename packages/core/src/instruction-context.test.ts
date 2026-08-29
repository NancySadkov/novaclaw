import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { instructionUpdate } from "./instruction-context"

/**
 * ── CACHE-005: ONE EDIT MUST NOT RE-SEND EVERY INSTRUCTION FILE ──────────────────────────────────
 *
 * 🔴 `core/instructions` measures **45,644 characters** in this repo (read from a live session's
 * context epoch). The update re-rendered ALL of it whenever ANY loaded file changed, into the durable
 * transcript — permanently, and re-summarised by every later compaction.
 *
 * ⚠️ It is a TAIL update, so it does not invalidate the prefix cache. The cost is transcript bloat and
 * a model re-reading instructions it already holds — the same shape as CACHE-004, which was measured
 * firing 13 times in one sweep.
 */

const file = (path: string, content: string) => ({ path, content }) as never
const AGENTS = file("C:/repo/AGENTS.md", "A".repeat(4_000))
const NESTED = file("C:/repo/pkg/AGENTS.md", "B".repeat(4_000))

describe("instructionUpdate", () => {
  test("editing ONE file does not re-send the others", () => {
    const edited = file("C:/repo/AGENTS.md", "A".repeat(4_000) + " and one new line")
    const update = instructionUpdate([AGENTS, NESTED], [edited, NESTED])
    expect(update).toContain("C:/repo/AGENTS.md")
    // 🔴 The whole point: the untouched file's 4,000 characters must not ride along.
    expect(update).not.toContain("B".repeat(100))
    expect(update).not.toContain("C:/repo/pkg/AGENTS.md")
  })

  /**
   * 🔴 THE CASE A "WHAT IS NEW" DIFF DROPS SILENTLY. A file that goes out of scope must be named, or
   * the model keeps obeying instructions from a file that is no longer loaded — which is exactly what
   * the whole-set `removed` hook exists to prevent, applied per file.
   */
  test("a file that is no longer loaded is reported", () => {
    const update = instructionUpdate([AGENTS, NESTED], [AGENTS])
    expect(update).toContain("No longer loaded")
    expect(update).toContain("C:/repo/pkg/AGENTS.md")
  })

  test("a newly discovered file is sent in full", () => {
    const update = instructionUpdate([AGENTS], [AGENTS, NESTED])
    expect(update).toContain("C:/repo/pkg/AGENTS.md")
    expect(update).toContain("B".repeat(100))
  })

  // ⚠️ Ordering churn with no content change must not emit an empty notice.
  test("falls back to the full render when nothing is attributable to a file", () => {
    const update = instructionUpdate([AGENTS, NESTED], [AGENTS, NESTED])
    expect(update).toContain("replace all previously loaded")
  })

  /**
   * 🔴 THE WIRING. Every test above imports the helper directly and passes just as well if
   * `instruction-context` never calls it — the shape this repo has shipped repeatedly, twice today.
   */
  test("core/instructions is wired to the diff", () => {
    const source = readFileSync(new URL("./instruction-context.ts", import.meta.url), "utf8")
    expect(source, "the source moved — re-point this, do not delete it").toContain('SystemContext.Key.make("core/instructions")')
    expect(source).toContain("update: instructionUpdate,")
    expect(source).not.toContain("update: (_previous, current) =>")
  })
})
