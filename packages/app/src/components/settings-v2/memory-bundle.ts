import type { MemoryRow } from "@/utils/memory-api"

// The portable memory backup format (notes/kb-graph-plan.md §4.11 / §5) — a lay "Export / Import my
// memory" bundle, distinct from the Developer whole-config Export/Import. Pure + versioned so the
// serialize/parse logic is unit-testable independent of the network and the UI.
//
// v1 fidelity note: the bundle carries the FACTS (kind/text/name/scope), not the graph's internal ids,
// bitemporal timestamps, or derived edges — those are re-minted/re-derived on import (memory is a
// best-effort, re-derivable tier). A restored memory is re-`remember`ed fresh; edges rebuild as the
// agent chats. The format is versioned so a future engine-native dump can supersede it losslessly.

export const MEMORY_BUNDLE_TYPE = "novaclaw-memory"
export const MEMORY_BUNDLE_VERSION = 1

export interface BundleMemory {
  readonly kind: string
  readonly text: string
  readonly name?: string
  readonly scope: string
}

export interface MemoryBundle {
  readonly $type: typeof MEMORY_BUNDLE_TYPE
  readonly version: number
  readonly exportedAt: string
  readonly memories: readonly BundleMemory[]
}

/** Serialize the current memories into a downloadable backup document. */
export function buildMemoryBundle(rows: readonly MemoryRow[], exportedAt: string): string {
  const memories: BundleMemory[] = rows.map((row) => ({
    kind: row.kind,
    text: row.text,
    ...(row.name ? { name: row.name } : {}),
    scope: row.scope,
  }))
  const bundle: MemoryBundle = {
    $type: MEMORY_BUNDLE_TYPE,
    version: MEMORY_BUNDLE_VERSION,
    exportedAt,
    memories,
  }
  return JSON.stringify(bundle, null, 2) + "\n"
}

export type ParseResult = { readonly ok: true; readonly memories: readonly BundleMemory[] } | { readonly ok: false; readonly error: "invalid" | "version" }

/** Validate + parse an imported backup document. Rejects a non-memory file (`invalid`) and a
 *  bundle from a newer format this build can't read (`version`). Skips malformed rows, keeps the
 *  well-formed ones (a partially-corrupt backup still restores what it can). */
export function parseMemoryBundle(text: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "invalid" }
  }
  if (parsed === null || typeof parsed !== "object") return { ok: false, error: "invalid" }
  const doc = parsed as Record<string, unknown>
  if (doc.$type !== MEMORY_BUNDLE_TYPE || !Array.isArray(doc.memories)) return { ok: false, error: "invalid" }
  if (typeof doc.version === "number" && doc.version > MEMORY_BUNDLE_VERSION) return { ok: false, error: "version" }
  const memories: BundleMemory[] = []
  for (const entry of doc.memories) {
    if (entry === null || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    if (typeof row.text !== "string" || !row.text.trim()) continue
    memories.push({
      kind: typeof row.kind === "string" && row.kind ? row.kind : "entity",
      text: row.text,
      ...(typeof row.name === "string" && row.name ? { name: row.name } : {}),
      scope: typeof row.scope === "string" && row.scope ? row.scope : "global",
    })
  }
  return { ok: true, memories }
}

/** Where an imported memory lands. A backup restored onto a fresh or other instance should become the
 *  instance's durable, cross-session knowledge; a source-instance chat scope (`session:<id>`) is
 *  meaningless here, so it promotes to global. Global stays global. */
export function importScope(scope: string): string {
  return scope.startsWith("session:") ? "global" : scope || "global"
}
