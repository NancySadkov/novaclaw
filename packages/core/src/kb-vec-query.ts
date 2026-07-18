export * as KbVecQuery from "./kb-vec-query"

// KB-V — the pure hybrid-retrieval query layer (notes/kb-vector-plan.md §1): SQL builders for
// the two candidate generators (vec0 KNN · FTS5 BM25) and the Reciprocal Rank Fusion that
// merges them. No IO, no services — the store/tool layers bind parameters and run these; unit
// tests exercise them against a fixture DB. Scope filtering ("core" | "staged" | "all") maps to
// the vec table's `relation` partition key and, on the FTS side, a kb_doc join.

export type Scope = "core" | "staged" | "all"

export interface Hit {
  readonly chunkID: string
  readonly docID: string
  readonly snippet: string
}

export interface Fused extends Hit {
  readonly score: number
}

/** How many candidates each generator contributes before fusion, given the caller's k. */
export const candidateLimit = (k: number) => Math.max(20, k * 4)

// vec0 KNN: `embedding MATCH ?` + `k = ?` is the documented KNN form; the partition-key
// equality prunes shards index-side. Params, in order: [embedding blob, k, scope?].
export const knnSql = (scope: Scope) => `
  SELECT chunk_id AS chunkID, doc_id AS docID, snippet, distance
  FROM kb_chunk_vec
  WHERE embedding MATCH ? AND k = ?${scope === "all" ? "" : " AND relation = ?"}
  ORDER BY distance`

// FTS5 BM25: rank inside the fts subquery (bm25() is only addressable there), then join back
// for ids + the defensive active-doc guard. Params, in order: [match expr, limit, scope?].
export const ftsSql = (scope: Scope) => `
  SELECT c.id AS chunkID, c.doc_id AS docID, substr(c.text, 1, 200) AS snippet, f.score
  FROM (
    SELECT rowid, bm25(kb_chunk_fts) AS score
    FROM kb_chunk_fts
    WHERE kb_chunk_fts MATCH ?
    ORDER BY score
    LIMIT ?
  ) f
  JOIN kb_chunk c ON c.rowid = f.rowid
  JOIN kb_doc d ON d.id = c.doc_id
  WHERE d.valid_to IS NULL${scope === "all" ? "" : " AND d.relation = ?"}
  ORDER BY f.score`

/**
 * Free text → a forgiving FTS5 MATCH expression: each token double-quoted (so FTS operators,
 * quotes, and punctuation in user text can never break the query syntax) and OR-joined (BM25
 * still ranks multi-token matches first, but a single matching token is enough to surface a
 * candidate — fuzziness over precision, the KB-V stance). Empty input yields undefined; callers
 * turn that into repair text, not a query.
 */
export const ftsMatchExpr = (query: string): string | undefined => {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 32)
  if (tokens.length === 0) return undefined
  return tokens.map((token) => `"${token.replaceAll(`"`, `""`)}"`).join(" OR ")
}

/**
 * Reciprocal Rank Fusion: score(item) = Σ over lists of 1 / (K + rank). The standard K=60
 * damps the head so an item ranked well by BOTH generators beats an item ranked first by one
 * and absent from the other — the whole point of hybrid. Input lists are best-first; ties
 * break toward the earlier list (vector first by convention).
 */
export const rrfFuse = (lists: ReadonlyArray<ReadonlyArray<Hit>>, k: number, K = 60): Fused[] => {
  const scores = new Map<string, { hit: Hit; score: number }>()
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = scores.get(hit.chunkID)
      const contribution = 1 / (K + rank + 1)
      if (entry === undefined) scores.set(hit.chunkID, { hit, score: contribution })
      else entry.score += contribution
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ hit, score }) => ({ ...hit, score }))
}
