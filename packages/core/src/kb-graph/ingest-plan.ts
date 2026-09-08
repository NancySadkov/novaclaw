import { KbChunk } from "./chunk"
import type { EdgeInput, MemoryInput } from "./memory-client"

/**
 * WHAT INGESTING A DOCUMENT WRITES — the plan, as a value, in the order it must be applied.
 *
 * 🔴 Why this is a module and not a loop inside the HTTP handler. The correctness property here is
 * ORDER — an edge needs both endpoints to exist, so the document entity must be written before its
 * passages and each passage before its own edge — and order was previously guarded by a test that
 * `readFileSync`'d the handler and compared `indexOf` positions. That is the *test that checks
 * itself*: it passes on source that reads correctly and says nothing about what reaches the store.
 * A plan that IS a sequence makes the property structural, and lets a real engine prove it.
 *
 * 🔴 The defect the plan encodes. Ingestion used to chunk and store, and nothing else. Measured on a
 * real store 2026-08-12: 280 nodes and **22 edges**, of which 202 were passages with none at all;
 * every passage carried `name: <document label>`, so 280 named nodes shared 63 distinct names
 * ("EDDS rules" x102) — a wall of identical marks with nothing joining them. Writing the document as
 * an entity and hanging its passages off it turns that wall into one navigable star per document, at
 * zero model cost, because the association was already in the data and was simply discarded.
 *
 * ⚠️ **`KbChunk.entityID` is the SAME function conversational extraction uses**, and that is the
 * point: a thing mentioned in a chat and a document of the same name land on ONE node. A second
 * formula mints a second node for one name and the graph re-fragments exactly where the entity layer
 * was meant to join it.
 *
 * ⚠️ This does NOT extract entities from passage CONTENT — a monster manual still has no `Siege Crab`
 * node. That needs a model pass per chunk (`absorb.ts`) and is the open half of the defect; a
 * connected graph here is not evidence that absorption works.
 */
export interface IngestPlan {
  /** The document, as a thing the graph knows about. Written FIRST. */
  readonly document: MemoryInput
  /** Each chunk, in document order. Each is written before its own edge. */
  readonly passages: readonly MemoryInput[]
  /** `passage -part_of-> document`, one per passage, in the same order. */
  readonly edges: readonly EdgeInput[]
  /** Every write, already interleaved into the ONE order that satisfies the endpoint rule. */
  readonly steps: readonly IngestStep[]
}

export type IngestStep = { readonly kind: "memory"; readonly input: MemoryInput } | {
  readonly kind: "edge"
  readonly input: EdgeInput
}

export interface IngestPlanInput {
  /** The document's name as the user gave it; blanks fall back to a stable placeholder. */
  readonly name: string
  readonly text: string
  readonly scope?: string
}

export const INGEST_SOURCE = "ingest"

/** Build the plan. Pure: no engine, no clock, no id that is not derived from the inputs. */
export function planIngest(input: IngestPlanInput): IngestPlan {
  const label = input.name.trim() || "document"
  const scope = input.scope?.trim() || "global"
  const chunks = KbChunk.chunk(KbChunk.stripGutenberg(input.text))
  const documentID = KbChunk.entityID(scope, label)

  const document: MemoryInput = {
    id: documentID,
    kind: "entity",
    text: label,
    name: label,
    scope,
    source: INGEST_SOURCE,
    relation: "staged",
  }

  const passages: MemoryInput[] = []
  const edges: EdgeInput[] = []
  const steps: IngestStep[] = [{ kind: "memory", input: document }]
  for (const text of chunks) {
    const passage: MemoryInput = {
      id: KbChunk.passageID(label, text),
      kind: "passage",
      text,
      name: label,
      scope,
      source: INGEST_SOURCE,
      relation: "staged",
    }
    const edge: EdgeInput = { from: passage.id, to: documentID, type: "part_of", scope, source: INGEST_SOURCE }
    passages.push(passage)
    edges.push(edge)
    // After the node, never before.
    steps.push({ kind: "memory", input: passage }, { kind: "edge", input: edge })
  }

  return { document, passages, edges, steps }
}
