import { describe, expect, test } from "bun:test"
import { KbTool } from "@novaclaw/core/tool/kb"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

// Pure rendering for the memory `kb` tool — linearized text lines (KB-E/KB-V rule), whitespace
// collapsed, name + provenance appended; a fruitless search settles as readable repair text.

const hit = (over: Partial<MemoryClient.SearchHit>): MemoryClient.SearchHit => ({
  id: "mem_1",
  kind: "entity",
  text: "The user   prefers\nTypeScript strict mode.",
  name: null,
  scope: "global",
  source: null,
  confidence: null,
  relation: "staged",
  score: 0.5,
  ...over,
})

describe("KbTool rendering", () => {
  test("formatHits: one line per memory, whitespace collapsed, name + provenance", () => {
    const out = KbTool.formatHits([
      hit({}),
      hit({ id: "mem_2", name: "Alice", text: "Alice lives in Berlin", source: "chat", relation: "core" }),
    ])
    const lines = out.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("mem_1 · The user prefers TypeScript strict mode. · staged")
    expect(lines[1]).toBe("mem_2 · Alice: Alice lives in Berlin · core/chat")
  })

  test("formatNeighbors: id · [type] text", () => {
    const rows: MemoryClient.Neighbor[] = [{ id: "mem_9", type: "works_at", text: "Acme  Corp" }]
    expect(KbTool.formatNeighbors(rows)).toBe("mem_9 · [works_at] Acme Corp")
  })

  test("searchRepair is actionable and quotes the query", () => {
    const msg = KbTool.searchRepair("quarterly revenue")
    expect(msg).toContain('"quarterly revenue"')
    expect(msg).toContain("remember")
  })

  test("relType normalizes a relationship label to a clean predicate token", () => {
    expect(KbTool.relType("works at")).toBe("works_at")
    expect(KbTool.relType("  Wrote  ABOUT ")).toBe("wrote_about")
    expect(KbTool.relType("located_in")).toBe("located_in")
    expect(KbTool.relType("")).toBe("related_to")
    expect(KbTool.relType("   ")).toBe("related_to")
  })
})
