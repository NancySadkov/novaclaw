export * as ReadGuidance from "./read-guidance"

// 1F harness-robustness: warn the model when a `read` returns a large slice of its
// context so small models continue in chunks (offset/limit) instead of trying to
// hold a whole file. The model only sees the structured read result as JSON, where a
// bare `truncated:true` field is not actioned — so we surface an explicit, imperative
// instruction. Pure and dependency-light so it is unit-testable without a model.
//
// Thresholds are fixed (not yet model-context-aware): ~24 KB / ~1500 lines is already
// a meaningful chunk for a small model. A *truncated* read always warns, because there
// is definitively more file to process.
export const LARGE_READ_LINES = 1500
export const LARGE_READ_BYTES = 24 * 1024

export interface ReadStats {
  readonly truncated: boolean
  readonly offset: number
  readonly lines: number
  readonly bytes: number
  readonly next?: number
}

export function guidance(stats: ReadStats): string | undefined {
  if (stats.truncated) {
    const last = stats.offset + Math.max(stats.lines, 1) - 1
    const resume = stats.next ?? last + 1
    return (
      `This file is too large to return in one read — you received lines ${stats.offset}-${last}. ` +
      `This is a PARTIAL view: you cannot review, summarize, or conclude anything about code you ` +
      `have not seen. Continue from offset ${resume} (pass it as \`offset\`) and process the file in ` +
      `chunks: read a range, handle it, then read the next. Do not assume the file ends here.`
    )
  }
  if (stats.lines >= LARGE_READ_LINES || stats.bytes >= LARGE_READ_BYTES) {
    return (
      `This is a large read (${stats.lines} lines, ~${Math.round(stats.bytes / 1024)} KB) and may take a ` +
      `significant part of your context. If you only need part of it, re-read specific ranges with ` +
      `\`offset\`/\`limit\` instead of keeping the whole file in context.`
    )
  }
  return undefined
}

// Convenience for the read tool: derive line/byte stats from the returned text.
export function forText(input: { text: string; truncated: boolean; offset: number; next?: number }): string | undefined {
  return guidance({
    truncated: input.truncated,
    offset: input.offset,
    lines: input.text.length === 0 ? 0 : input.text.split("\n").length,
    bytes: Buffer.byteLength(input.text, "utf8"),
    ...(input.next === undefined ? {} : { next: input.next }),
  })
}
