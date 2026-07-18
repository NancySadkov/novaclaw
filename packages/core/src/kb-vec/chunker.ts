export * as KbChunker from "./chunker"

// KB-V P2 — the pure chunking policy (notes/kb-vector-plan.md §3): ~256–512 estimated tokens
// per chunk with a small overlap, splitting on paragraph then sentence boundaries so a chunk
// never starts mid-thought when the source allows it. Pure text→chunks; no IO, no services.

export interface Chunk {
  readonly seq: number
  readonly text: string
  readonly tokenEstimate: number
}

export interface Options {
  /** Soft target size per chunk, in estimated tokens (default 380). */
  readonly target?: number
  /** Units of trailing context repeated at the next chunk's start (default 1 sentence). */
  readonly overlapUnits?: number
}

// The classic ~4-chars-per-token heuristic — the KB never needs exact counts, only sizing.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const DEFAULT_TARGET = 380

// Split into sentence-ish units, paragraph breaks preserved as hard boundaries. A "unit" is the
// atom chunks are built from; an oversized unit (no sentence breaks — minified text, logs) is
// hard-split so no unit alone exceeds the target.
const units = (text: string, target: number): string[] => {
  const out: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (estimateTokens(sentence) <= target) {
        out.push(sentence)
        continue
      }
      const step = target * 4
      for (let at = 0; at < sentence.length; at += step) out.push(sentence.slice(at, at + step))
    }
  }
  return out
}

/**
 * Greedy accumulation of units up to the target, with the last `overlapUnits` units of each
 * chunk repeated at the start of the next (retrieval context stitching). Empty/whitespace input
 * yields no chunks — callers treat that as unindexable, not an error.
 */
export const chunk = (text: string, options?: Options): Chunk[] => {
  const target = options?.target ?? DEFAULT_TARGET
  const overlapUnits = options?.overlapUnits ?? 1
  const parts = units(text, target)
  if (parts.length === 0) return []

  const chunks: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  for (const unit of parts) {
    const unitTokens = estimateTokens(unit)
    if (current.length > 0 && currentTokens + unitTokens > target) {
      chunks.push(current)
      // Overlap is a SMALL tail (≤ target/4 tokens) — a target-sized unit carried over would
      // double the next chunk instead of stitching context, so big tails just don't overlap.
      const overlap: string[] = []
      let overlapTokens = 0
      for (let at = current.length - 1; at >= 0 && overlap.length < overlapUnits; at--) {
        const tokens = estimateTokens(current[at]!)
        if (overlapTokens + tokens > target / 4) break
        overlap.unshift(current[at]!)
        overlapTokens += tokens
      }
      current = overlap
      currentTokens = overlapTokens
    }
    current.push(unit)
    currentTokens += unitTokens
  }
  if (current.length > 0) chunks.push(current)

  return chunks.map((chunkUnits, seq) => {
    const joined = chunkUnits.join(" ")
    return { seq, text: joined, tokenEstimate: estimateTokens(joined) }
  })
}
