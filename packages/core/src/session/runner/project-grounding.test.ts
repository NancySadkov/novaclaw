import { describe, expect, test } from "bun:test"
import { ProjectGrounding } from "./project-grounding"

const input = (over: Partial<Parameters<typeof ProjectGrounding.decide>[0]> = {}) => ({
  enabled: true,
  directory: "/work/project",
  contextTokens: 100,
  ...over,
})

describe("project grounding cadence", () => {
  test("fires initially, then stays quiet below the 64K interval", () => {
    const initial = ProjectGrounding.decide(input(), undefined)
    expect(initial.due).toBe(true)
    expect(ProjectGrounding.decide(input({ contextTokens: 100 + ProjectGrounding.TOKEN_INTERVAL - 1 }), initial.state).due).toBe(false)
  })

  test("fires at each additional 64K interval without oversized-turn drift", () => {
    const initial = ProjectGrounding.decide(input(), undefined)
    const crossed = ProjectGrounding.decide(
      input({ contextTokens: 100 + ProjectGrounding.TOKEN_INTERVAL * 2 + 9 }),
      initial.state,
    )
    expect(crossed).toEqual({
      due: true,
      state: { directory: "/work/project", tokenAnchor: 100 + ProjectGrounding.TOKEN_INTERVAL * 2 },
    })
    expect(ProjectGrounding.decide(input({ contextTokens: crossed.state!.tokenAnchor + 1 }), crossed.state).due).toBe(false)
  })

  test("fires after compaction and resets the interval anchor", () => {
    const initial = ProjectGrounding.decide(input({ compactionID: "cmp_old" }), undefined)
    const compacted = ProjectGrounding.decide(input({ compactionID: "cmp_new", contextTokens: 40 }), initial.state)
    expect(compacted).toEqual({
      due: true,
      state: { directory: "/work/project", compactionID: "cmp_new", tokenAnchor: 40 },
    })
    expect(ProjectGrounding.decide(input({ compactionID: "cmp_new", contextTokens: 41 }), compacted.state).due).toBe(false)
  })

  test("fires when the directory changes and is entirely inert for Strict", () => {
    const initial = ProjectGrounding.decide(input(), undefined)
    expect(ProjectGrounding.decide(input({ directory: "/work/other" }), initial.state).due).toBe(true)
    expect(ProjectGrounding.decide(input({ enabled: false }), initial.state)).toEqual({ due: false })
  })
})

describe("project grounding copy", () => {
  test("names a useful project root and Git without inventing a drive-root workspace", () => {
    expect(
      ProjectGrounding.render({ directory: "/repo/packages/core", root: "/repo", vcs: { type: "git" } }),
    ).toContain("Project root: /repo")
    expect(ProjectGrounding.render({ directory: "C:\\work", root: "C:\\" })).not.toContain("Project root:")
  })
})
