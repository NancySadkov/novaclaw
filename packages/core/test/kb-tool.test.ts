import { describe, expect, test } from "bun:test"
import { KbTool } from "@novaclaw/core/tool/kb"
import type { KbDocs } from "@novaclaw/core/kb-docs"

const HIT: KbDocs.SearchHit = {
  docID: "doc_1",
  chunkID: "chk_1",
  title: "Rust memory model",
  snippet: "Rust ownership   rules.\nBorrowing enforces lifetimes.",
  score: 0.031,
  relation: "core",
  source: "wiki",
}

describe("KbTool rendering", () => {
  test("formatHits linearizes one hit per line with provenance, whitespace flattened", () => {
    const lines = KbTool.formatHits([HIT, { ...HIT, docID: "doc_2", source: undefined, agent: "bot", relation: "staged" }])
    expect(lines.split("\n")).toEqual([
      "doc_1 · Rust memory model · Rust ownership rules. Borrowing enforces lifetimes. · core/wiki",
      "doc_2 · Rust memory model · Rust ownership rules. Borrowing enforces lifetimes. · staged/bot",
    ])
  })

  test("searchRepair names the degraded mode only when semantic search was down", () => {
    expect(KbTool.searchRepair("quarks", true)).not.toContain("Semantic search was unavailable")
    expect(KbTool.searchRepair("quarks", false)).toContain("Semantic search was unavailable")
    expect(KbTool.searchRepair("quarks", true)).toContain(`"quarks"`)
  })

  test("formatDoc renders title, provenance line, and the full text; retraction is visible", () => {
    const doc: KbDocs.Doc = {
      id: "doc_1",
      title: "Rust memory model",
      text: "The full text.",
      relation: "core",
      source: "wiki",
      contentHash: "h",
      validFrom: 1,
      validTo: 2,
      supersededBy: "doc_9",
      timeCreated: 1,
    }
    const rendered = KbTool.formatDoc(doc)
    expect(rendered).toContain("Rust memory model\n")
    expect(rendered).toContain("id: doc_1 · relation: core · source: wiki · RETRACTED · superseded by doc_9")
    expect(rendered.endsWith("The full text.")).toBe(true)
  })

  test("formatSources aggregates and names the empty KB", () => {
    expect(KbTool.formatSources([])).toBe("The KB is empty.")
    expect(
      KbTool.formatSources([
        { source: "wiki", relation: "core", docs: 3 },
        { agent: "bot", relation: "staged", docs: 1 },
      ]).split("\n"),
    ).toEqual(["wiki · core · 3 docs", "bot · staged · 1 docs"])
  })
})
