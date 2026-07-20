import { describe, expect, test } from "bun:test"
import { batches, parseEmbeddings } from "./embedder"

// The embedder must NEVER fail a caller — a malformed/short reply degrades to `undefined` so the call
// site falls back to keyword-only search. These cover the pure halves; the network path is covered by
// the live RAG eval (tests/rag-corpus-eval.ts).

describe("batches", () => {
  test("splits into request-sized groups, preserving order", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  test("empty in, empty out; a size below 1 never loops forever", () => {
    expect(batches([], 32)).toEqual([])
    expect(batches([1, 2], 0)).toEqual([[1], [2]])
  })
})

describe("parseEmbeddings", () => {
  const reply = (rows: unknown[]) => ({ data: rows })

  test("returns vectors ordered by index, not arrival order", () => {
    const out = parseEmbeddings(reply([{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }]), 2)
    expect(out).toEqual([[1, 2], [3, 4]])
  })

  test("degrades to undefined when the count doesn't match what we asked for", () => {
    // A short reply would silently mis-pair vectors with their texts — refuse it.
    expect(parseEmbeddings(reply([{ index: 0, embedding: [1] }]), 2)).toBeUndefined()
  })

  test("degrades on a malformed shape rather than throwing", () => {
    expect(parseEmbeddings(undefined, 1)).toBeUndefined()
    expect(parseEmbeddings({}, 1)).toBeUndefined()
    expect(parseEmbeddings(reply([{ index: 0 }]), 1)).toBeUndefined() // no embedding
    expect(parseEmbeddings(reply([{ index: 0, embedding: [] }]), 1)).toBeUndefined() // empty vector
  })

  test("degrades on non-finite numbers (NaN would poison the vector index)", () => {
    expect(parseEmbeddings(reply([{ index: 0, embedding: [1, Number.NaN] }]), 1)).toBeUndefined()
    expect(parseEmbeddings(reply([{ index: 0, embedding: [1, "x"] }]), 1)).toBeUndefined()
  })
})
