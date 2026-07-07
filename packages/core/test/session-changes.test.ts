// F1f — the drain-end session-changes summary's pure halves: the cumulative snapshot
// boundary scan (first assistant `snapshot.start` → last `snapshot.end`) and the fold of
// snapshot file diffs into the legacy record summary the app's Changes review reads.
import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionChanges } from "@novaclaw/core/session/changes"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Revert } from "@novaclaw/schema/revert"
import { RelativePath } from "@novaclaw/schema/schema"

const created = DateTime.makeUnsafe(0)
const model = { id: "qwen", providerID: "dgx-spark" } as SessionMessage.Assistant["model"]

const assistant = (id: string, snapshot?: { start?: string; end?: string }): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make(`msg_${id}`),
  type: "assistant",
  agent: "build",
  model,
  content: [],
  ...(snapshot ? { snapshot } : {}),
  time: { created },
})

const user = (id: string): SessionMessage.User => ({
  id: SessionMessage.ID.make(`msg_${id}`),
  type: "user",
  text: "hi",
  time: { created },
})

describe("SessionChanges.boundaries", () => {
  test("first assistant start, last assistant end, across turns", () => {
    const messages = [
      user("u1"),
      assistant("a1", { start: "tree_1", end: "tree_2" }),
      user("u2"),
      assistant("a2", { start: "tree_2", end: "tree_3" }),
      assistant("a3", {}),
    ]
    expect(SessionChanges.boundaries(messages)).toEqual({ from: "tree_1", to: "tree_3" })
  })

  test("no snapshots -> no boundaries (pure-chat session, or snapshots disabled)", () => {
    expect(SessionChanges.boundaries([user("u1"), assistant("a1")])).toEqual({ from: undefined, to: undefined })
  })

  test("start-only transcript yields no end boundary", () => {
    const { from, to } = SessionChanges.boundaries([assistant("a1", { start: "tree_1" })])
    expect(from).toBe("tree_1")
    expect(to).toBeUndefined()
  })
})

describe("SessionChanges.summary", () => {
  const diff = (path: string, additions: number, deletions: number): Revert.FileDiff => ({
    path: RelativePath.make(path),
    status: "modified",
    additions,
    deletions,
    patch: `--- a/${path}`,
  })

  test("folds counters and maps the wire diffs", () => {
    const summary = SessionChanges.summary([diff("a.ts", 3, 1), diff("b.ts", 2, 0)])
    expect(summary.additions).toBe(5)
    expect(summary.deletions).toBe(1)
    expect(summary.files).toBe(2)
    expect(summary.diffs).toEqual([
      { file: "a.ts", patch: "--- a/a.ts", additions: 3, deletions: 1, status: "modified" },
      { file: "b.ts", patch: "--- a/b.ts", additions: 2, deletions: 0, status: "modified" },
    ])
  })

  test("empty diff folds to a zero summary that still compares equal to itself", () => {
    const summary = SessionChanges.summary([])
    expect(summary).toEqual({ additions: 0, deletions: 0, files: 0, diffs: [] })
    expect(SessionChanges.equal(summary, SessionChanges.summary([]))).toBe(true)
  })

  test("equal treats undefined and a differing summary correctly (the runner's dedup)", () => {
    const a = SessionChanges.summary([diff("a.ts", 1, 0)])
    expect(SessionChanges.equal(undefined, undefined)).toBe(true)
    expect(SessionChanges.equal(a, undefined)).toBe(false)
    expect(SessionChanges.equal(a, SessionChanges.summary([diff("a.ts", 1, 0)]))).toBe(true)
    expect(SessionChanges.equal(a, SessionChanges.summary([diff("a.ts", 2, 0)]))).toBe(false)
  })
})
