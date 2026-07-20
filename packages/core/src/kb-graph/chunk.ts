export * as KbChunk from "./chunk"

// Document chunking for the memory tier — turning a document into retrievable PASSAGE nodes (KB-D:
// agents populate memory from documents, not just conversation). Product code, not test scaffolding:
// every ingestion path should cut passages the same way, or retrieval behaves differently depending on
// who ingested.
//
// HEADER-AWARE by measurement, not taste. Naive size-based splitting separates a table's HEADER from
// its ROWS — so a chunk reads `1. Miss and actor gains Disadvantage` with no trace of the words "D20"
// or "ATTACK", and a keyword query for "D20 ATTACK table" can NEVER match it. Carrying the section
// heading into every chunk cut from that section fixed exactly that class (measured: +15 points on the
// document-RAG eval; the uncontaminated corpus went 0/6 → 4/6).
//
// ⚠️ Counter-measured: splitting a table into ONE CHUNK PER ROW makes it WORSE, not better — each row
// loses its sibling context and the rows compete with each other for the same query. Keep rows together
// under their heading.

import { createHash } from "node:crypto"

export const CHUNK_CHARS = 900

/** Content-addressed passage id, so re-ingesting a document is IDEMPOTENT rather than duplicating it.
 *  Keyed on (source label + passage text): the same passage from the same document always lands on the
 *  same id, and the engine's primary key rejects the duplicate. */
export const passageID = (label: string, text: string) =>
  "mem_p" + createHash("sha256").update(`${label}
${text}`).digest("hex").slice(0, 24)

/** Strip Project Gutenberg boilerplate when present; a no-op for other sources. */
export const stripGutenberg = (raw: string): string => {
  const start = raw.indexOf("*** START OF THE PROJECT GUTENBERG")
  const end = raw.indexOf("*** END OF THE PROJECT GUTENBERG")
  return raw.slice(start >= 0 ? raw.indexOf("\n", start) + 1 : 0, end >= 0 ? end : raw.length).replace(/\r\n/g, "\n")
}

/** A section heading: short, mostly-uppercase, not a sentence. Catches rules-section titles AND
 *  stat-block names (including titles wrapped across two lines, which are joined). */
export const isHeading = (line: string): boolean => {
  const t = line.trim()
  if (t.length < 3 || t.length > 48) return false
  const letters = t.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3) return false
  return t.replace(/[^A-Z]/g, "").length / letters.length > 0.8 && !/[.!?,;:]$/.test(t)
}

/** Cut `text` into passages of at most ~`chunkChars`, each prefixed with the section heading it came
 *  from (`[HEADING] body…`) so the heading's words are searchable from every row of that section. */
export const chunk = (text: string, chunkChars = CHUNK_CHARS): string[] => {
  const out: string[] = []
  let heading = ""
  let prevWasHeading = false
  let buf: string[] = []
  let size = 0
  const flush = () => {
    const body = buf.join("\n").trim()
    if (body) out.push(heading ? `[${heading}] ${body}` : body)
    buf = []
    size = 0
  }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t]+/g, " ").trim()
    if (isHeading(line)) {
      // Consecutive headings are a wrapped title ("AMBUSH" / "DRAKE"), not two sections.
      if (prevWasHeading) heading = `${heading} ${line}`.trim()
      else {
        flush()
        heading = line
      }
      prevWasHeading = true
      continue
    }
    prevWasHeading = false
    if (!line) continue
    if (size + line.length > chunkChars) flush()
    buf.push(line)
    size += line.length + 1
  }
  flush()
  return out
}
