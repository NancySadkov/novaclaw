import { describe, expect, test } from "bun:test"
import type { MemoryRow } from "@/utils/memory-api"
import {
  buildMemoryBundle,
  importScope,
  MEMORY_BUNDLE_TYPE,
  MEMORY_BUNDLE_VERSION,
  parseMemoryBundle,
} from "./memory-bundle"

const row = (over: Partial<MemoryRow>): MemoryRow => ({
  id: "mem_1",
  kind: "entity",
  text: "the user likes Haskell",
  name: null,
  scope: "global",
  source: "auto-extract",
  confidence: 0.8,
  relation: "staged",
  ...over,
})

describe("buildMemoryBundle", () => {
  test("carries the facts (kind/text/name/scope), drops ids + provenance + timestamps", () => {
    const doc = JSON.parse(buildMemoryBundle([row({ name: "Haskell" }), row({ id: "mem_2", scope: "session:s1", text: "lives in Kyoto" })], "2026-07-19T00:00:00Z"))
    expect(doc.$type).toBe(MEMORY_BUNDLE_TYPE)
    expect(doc.version).toBe(MEMORY_BUNDLE_VERSION)
    expect(doc.exportedAt).toBe("2026-07-19T00:00:00Z")
    expect(doc.memories).toEqual([
      { kind: "entity", text: "the user likes Haskell", name: "Haskell", scope: "global" },
      { kind: "entity", text: "lives in Kyoto", scope: "session:s1" },
    ])
  })

  test("round-trips through parse", () => {
    const text = buildMemoryBundle([row({})], "2026-07-19T00:00:00Z")
    const result = parseMemoryBundle(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.memories).toEqual([{ kind: "entity", text: "the user likes Haskell", scope: "global" }])
  })
})

describe("parseMemoryBundle", () => {
  test("rejects non-JSON", () => {
    expect(parseMemoryBundle("not json")).toEqual({ ok: false, error: "invalid" })
  })

  test("rejects a foreign document", () => {
    expect(parseMemoryBundle(JSON.stringify({ $type: "something-else", memories: [] }))).toEqual({ ok: false, error: "invalid" })
    expect(parseMemoryBundle(JSON.stringify({ memories: [] }))).toEqual({ ok: false, error: "invalid" })
  })

  test("rejects a newer format version", () => {
    const text = JSON.stringify({ $type: MEMORY_BUNDLE_TYPE, version: MEMORY_BUNDLE_VERSION + 1, memories: [] })
    expect(parseMemoryBundle(text)).toEqual({ ok: false, error: "version" })
  })

  test("skips malformed rows, keeps the good ones + applies defaults", () => {
    const text = JSON.stringify({
      $type: MEMORY_BUNDLE_TYPE,
      version: 1,
      memories: [
        { text: "kept, defaulted" }, // no kind/scope → defaults
        { text: "   " }, // blank text → skipped
        { kind: "episode", text: "full", name: "N", scope: "global" },
        null, // junk → skipped
        { name: "no text" }, // missing text → skipped
      ],
    })
    const result = parseMemoryBundle(text)
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.memories).toEqual([
        { kind: "entity", text: "kept, defaulted", scope: "global" },
        { kind: "episode", text: "full", name: "N", scope: "global" },
      ])
  })
})

describe("importScope", () => {
  test("promotes a source chat scope to global, keeps global, backfills empty", () => {
    expect(importScope("session:abc")).toBe("global")
    expect(importScope("global")).toBe("global")
    expect(importScope("")).toBe("global")
  })
})
