export * as MemoryRerank from "./rerank"

import type { SearchHit } from "./wasm-engine"

// P8d — MODEL-DECIDED recall ordering (owner 2026-07-20: "the model itself has to decide on good
// ranking, given such example(s)"). The deterministic ranker (ranking.ts) orders by metadata —
// recency × provenance tier — which cannot read AUTHORITATIVENESS OUT OF THE TEXT. Metadata says a
// three-day-old note beats a year-old one; only a reader can see that "I think nobody checks anymore"
// is idle speculation while "Official policy: three days in office" is definitive, and rank
// accordingly. So the model ranks, guided by a worked example of the principle.
//
// Non-negotiables, mirroring the embedder:
//   • NEVER fails a caller. No model, a timeout, or an unparseable reply ⇒ `undefined`, and the caller
//     falls back to the deterministic ranker. Ordering degrading is fine; a broken turn is not.
//   • LOSSLESS. A partial or truncated ordering is repaired by appending whatever the model omitted,
//     in its original retrieval order — candidates can be REORDERED but never silently dropped.
//   • Pure halves (prompt build + parse) are unit-tested; the model call is injected.

/** Compact one-line view of a candidate: what the model needs to judge, and nothing else. */
const describe = (hit: SearchHit, nowMs: number): string => {
  const age = hit.validAt ? Math.max(0, Math.round((nowMs - Date.parse(hit.validAt)) / 86_400_000)) : undefined
  const when = age === undefined ? "age unknown" : age === 0 ? "today" : `${age}d old`
  const tier = hit.relation === "core" ? "curated" : hit.source === "auto-extract" ? "auto-noted" : "user-recorded"
  return `${when}; ${tier}) ${hit.text.replace(/\s+/g, " ").trim()}`
}

export interface RerankPrompt {
  readonly system: string
  readonly user: string
}

/** Build the ranking prompt. The example teaches the PRINCIPLE (definitive+current beats casual+stale)
 *  rather than any particular domain, so it generalises past the example that motivated it. */
export function buildRerankPrompt(query: string, candidates: ReadonlyArray<SearchHit>, nowMs: number): RerankPrompt {
  const system = [
    "You order remembered facts by how useful each is for answering a question.",
    "Judge, in order of importance:",
    "1. Does it actually answer the question? An off-topic fact ranks last however recent or official.",
    "2. How authoritative is it? A definitive, firsthand or official statement outranks hedged musing,",
    "   speculation or hearsay — read the WORDING, not just the label.",
    "3. How current is it? When two facts speak to the same thing, the newer one supersedes the older.",
    'Example — question: "what is the remote-work policy?"',
    '  A) 400d old: "Official policy: three days a week in the office."',
    '  B) 3d old: "I think nobody really checks the office days anymore."',
    "  Correct order: A, B. B is newer but it is one person speculating; A is the actual policy.",
    "Reply with ONLY the candidate numbers, best first, comma-separated. No words, no explanation.",
  ].join("\n")
  const lines = candidates.map((hit, i) => `${i + 1}. (${describe(hit, nowMs)}`).join("\n")
  const user = `Question: ${query}\n\nCandidates:\n${lines}\n\nBest-first order:`
  return { system, user }
}

/** Parse the model's ordering into candidate INDICES (0-based). Tolerant by design: it accepts any
 *  digit-separated shape, ignores out-of-range and duplicate picks, and APPENDS anything the model
 *  omitted so the result is always a complete permutation. `undefined` only when nothing usable came
 *  back at all — which routes the caller to the deterministic fallback. */
export function parseRerankOrder(reply: string, count: number): number[] | undefined {
  if (count <= 0) return undefined
  const picked: number[] = []
  const seen = new Set<number>()
  for (const match of reply.matchAll(/\d+/g)) {
    const index = Number(match[0]) - 1
    if (index < 0 || index >= count || seen.has(index)) continue
    seen.add(index)
    picked.push(index)
  }
  if (picked.length === 0) return undefined
  for (let i = 0; i < count; i++) if (!seen.has(i)) picked.push(i) // never drop a candidate
  return picked
}

/** One-shot completion the reranker drives. Injected so this module stays model-agnostic + testable. */
export type Complete = (prompt: RerankPrompt) => Promise<string>

/** Model-decided ordering. Returns the reordered hits, or `undefined` to fall back. */
export async function rerank(
  query: string,
  candidates: ReadonlyArray<SearchHit>,
  complete: Complete,
  nowMs: number,
): Promise<SearchHit[] | undefined> {
  // Nothing to decide: 0 or 1 candidates, or a blank query.
  if (candidates.length < 2 || !query.trim()) return undefined
  try {
    const reply = await complete(buildRerankPrompt(query, candidates, nowMs))
    const order = parseRerankOrder(reply, candidates.length)
    return order?.map((index) => candidates[index]!)
  } catch {
    return undefined // unreachable model / timeout / anything else ⇒ deterministic fallback
  }
}
