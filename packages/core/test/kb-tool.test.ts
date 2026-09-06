import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
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
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
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

  test("model-facing renderers can replace every storage id with an opaque reference", () => {
    const render = () => "ref_test"
    expect(KbTool.formatHits([hit({ id: "mem_secret" })], render)).toContain("ref_test ·")
    expect(KbTool.formatHits([hit({ id: "mem_secret" })], render)).not.toContain("mem_secret")
    expect(KbTool.formatNeighbors([{ id: "mem_secret", type: "about", text: "fact" }], render)).toBe(
      "ref_test · [about] fact",
    )
  })

  test("formatPath renders only bounded references", () => {
    expect(KbTool.formatPath({ ids: ["mem_a", "mem_b"], hops: 1 }, () => "ref_test")).toBe(
      "Path (1 hops): ref_test → ref_test",
    )
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

// The roster's memory boundary, at the WRITE/READ surface the model actually drives (AGENTS.md — the
// structural metaphor). The negative cases are the point: no value of `scope` reaches another
// officer's cabinet, and a narrowing request is never widened.
describe("KbTool scopes", () => {
  test("search: all (the default) reads this chat, my own cabinet and the household", () => {
    expect(MemoryAccess.scopesForSearch("session:ses_1", "trader", undefined)).toEqual([
      "session:ses_1",
      "agent:trader",
      "global",
    ])
    expect(MemoryAccess.scopesForSearch("session:ses_1", "trader", "all")).toEqual([
      "session:ses_1",
      "agent:trader",
      "global",
    ])
  })

  test("search: no scope value can reach another agent's cabinet", () => {
    for (const scope of ["session", "agent", "global", "all"] as const) {
      expect(MemoryAccess.scopesForSearch("session:ses_1", "dungeon-master", scope)).not.toContain("agent:trader")
    }
  })

  test("search: each narrowing scope reads exactly one place", () => {
    expect(MemoryAccess.scopesForSearch("session:ses_1", "trader", "session")).toEqual(["session:ses_1"])
    expect(MemoryAccess.scopesForSearch("session:ses_1", "trader", "agent")).toEqual(["agent:trader"])
    expect(MemoryAccess.scopesForSearch("session:ses_1", "trader", "global")).toEqual(["global"])
  })

  test("search: asking for `agent` without one degrades to this chat, never to global", () => {
    // Widening a narrowing request is the one direction that can leak: a session with no officer
    // asking for "my own memory" must not be handed the household pile.
    expect(MemoryAccess.scopesForSearch("session:ses_1", undefined, "agent")).toEqual(["session:ses_1"])
    expect(MemoryAccess.scopesForSearch("session:ses_1", "", "agent")).toEqual(["session:ses_1"])
  })

  test("search: with no agent, the pre-roster shape is unchanged", () => {
    expect(MemoryAccess.scopesForSearch("session:ses_1", undefined, undefined)).toEqual(["session:ses_1", "global"])
  })

  test("write: defaults to the officer's cabinet, not the household pile", () => {
    expect(MemoryAccess.scopeForWrite("session:ses_1", "trader", undefined)).toBe("agent:trader")
    expect(MemoryAccess.scopeForWrite("session:ses_1", "trader", "agent")).toBe("agent:trader")
  })

  test("write: explicit scopes are honoured", () => {
    expect(MemoryAccess.scopeForWrite("session:ses_1", "trader", "session")).toBe("session:ses_1")
    expect(MemoryAccess.scopeForWrite("session:ses_1", "trader", "global")).toBe("global")
  })

  test("write: with no agent, global stays the durable default", () => {
    expect(MemoryAccess.scopeForWrite("session:ses_1", undefined, undefined)).toBe("global")
    expect(MemoryAccess.scopeForWrite("session:ses_1", "", undefined)).toBe("global")
  })
})
